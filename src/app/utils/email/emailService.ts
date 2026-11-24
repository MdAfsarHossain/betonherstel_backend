import httpStatus from "http-status";
import nodemailer, { Transporter } from "nodemailer";
import config from "../../../config";
import ApiError from "../../errors/ApiError";
import { SettingsService } from "../../modules/settings/settings.service";
import { query } from "../db";
import { TLanguage } from "../i18n";
import { TTemplateKey } from "./defaultTemplates";
import { getEffectiveTemplate, renderMergeFields } from "./templates";

// Sends every email the CRM produces and logs each one on the record it belongs
// to (FR-MSG-02). Quotations, invoices, reminders, work orders and portal
// invitations all go through sendTemplatedEmail.

let transporter: Transporter | null = null;

const getTransporter = () => {
  if (!transporter) {
    if (!config.emailSender.email || !config.emailSender.app_pass) {
      throw new ApiError(
        httpStatus.INTERNAL_SERVER_ERROR,
        "Email configuration missing",
      );
    }
    transporter = nodemailer.createTransport({
      host: config.emailSender.host,
      port: config.emailSender.port,
      secure: config.emailSender.port === 465,
      auth: {
        user: config.emailSender.email,
        pass: config.emailSender.app_pass,
      },
      pool: true,
      connectionTimeout: 10000,
    });
  }
  return transporter;
};

// Lets tests capture emails instead of sending them
export const setMailTransporter = (custom: Transporter | null) => {
  transporter = custom;
};

export interface IEmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ISendEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: IEmailAttachment[];
  templateKey?: TTemplateKey;
  language?: TLanguage;
  // The record the email belongs to, e.g. { type: "invoice", id }
  related?: { type: string; id: string };
  sentBy?: string | null;
  fromName?: string;
}

const htmlToText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const writeLog = async (
  input: ISendEmail,
  status: "SENT" | "FAILED",
  error?: string,
) => {
  try {
    await query(
      `
        INSERT INTO email_log (
            to_email, subject, template_key, language, status, error,
            related_type, related_id, sent_by
        ) VALUES ($1, $2, $3, $4::"Language", $5, $6, $7, $8::uuid, $9::uuid)
      `,
      [
        input.to,
        input.subject.slice(0, 255),
        input.templateKey ?? null,
        input.language ?? null,
        status,
        error ?? null,
        input.related?.type ?? null,
        input.related?.id ?? null,
        input.sentBy ?? null,
      ],
    );
  } catch (logError) {
    // A logging problem must never hide the result of the send itself
    console.error("❌ Could not write email log:", logError);
  }
};

export const sendEmail = async (input: ISendEmail) => {
  try {
    await getTransporter().sendMail({
      from: `"${input.fromName ?? "Betonherstel"}" <${config.emailSender.email}>`,
      to: input.to,
      subject: input.subject,
      text: input.text ?? htmlToText(input.html),
      html: input.html,
      attachments: input.attachments,
    });
  } catch (error: any) {
    await writeLog(input, "FAILED", error?.message ?? "Unknown error");
    console.error("❌ Email failed:", error?.message);
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      "Email could not be sent. Please try again later.",
    );
  }
  await writeLog(input, "SENT");
};

// Branded wrapper around the template body
const wrapLayout = (
  body: string,
  company: {
    company_name: string;
    logo_url?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
  },
) => `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2933;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background:#1e3a5f;padding:24px 32px;color:#ffffff;font-size:20px;font-weight:bold;">${
  company.logo_url
    ? `<img src="${renderMergeFields("{{u}}", { u: company.logo_url })}" alt="${renderMergeFields("{{n}}", { n: company.company_name })}" style="max-height:48px;"/>`
    : renderMergeFields("{{n}}", { n: company.company_name })
}</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6;">${body}</td></tr>
<tr><td style="padding:16px 32px;background:#f9fafb;color:#6b7280;font-size:12px;">${renderMergeFields("{{n}}", { n: company.company_name })}${
  company.email
    ? ` &middot; ${renderMergeFields("{{e}}", { e: company.email })}`
    : ""
}${company.phone ? ` &middot; ${renderMergeFields("{{p}}", { p: company.phone })}` : ""}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

export interface ISendTemplatedEmail {
  to: string;
  templateKey: TTemplateKey;
  // The recipient's preferred language (FR-I18N-03)
  language: TLanguage;
  variables?: Record<string, string | number | null | undefined>;
  attachments?: IEmailAttachment[];
  related?: { type: string; id: string };
  sentBy?: string | null;
}

export const sendTemplatedEmail = async (input: ISendTemplatedEmail) => {
  const [company, template] = await Promise.all([
    SettingsService.getCompanySettings(),
    getEffectiveTemplate(input.templateKey, input.language),
  ]);

  const variables = { company_name: company.company_name, ...input.variables };
  const subject = renderMergeFields(template.subject, variables, false);
  const html = wrapLayout(
    renderMergeFields(template.body_html, variables),
    company,
  );

  await sendEmail({
    to: input.to,
    subject,
    html,
    attachments: input.attachments,
    templateKey: input.templateKey,
    language: input.language,
    related: input.related,
    sentBy: input.sentBy,
    fromName: company.company_name,
  });
};
