import { query } from "../db";
import { TLanguage } from "../i18n";
import {
  defaultTemplates,
  IEmailTemplate,
  TTemplateKey,
} from "./defaultTemplates";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Replaces {{field}} with the value, HTML-escaped. Unknown fields become empty.
// Set `escape` to false for plain text such as the email subject.
export const renderMergeFields = (
  template: string,
  variables: Record<string, string | number | null | undefined>,
  escape = true,
) =>
  template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_m, key: string) => {
    const value = variables[key];
    if (value === null || value === undefined) return "";
    return escape ? escapeHtml(String(value)) : String(value);
  });

// The template to send: the Beheerder's override if there is one, else the built-in default
export const getEffectiveTemplate = async (
  key: TTemplateKey,
  language: TLanguage,
): Promise<IEmailTemplate & { isCustomized: boolean }> => {
  const result = await query(
    `SELECT subject, body_html FROM email_templates
     WHERE template_key = $1 AND language = $2::"Language"`,
    [key, language],
  );

  if (result.rows.length > 0) {
    return { ...result.rows[0], isCustomized: true };
  }
  return { ...defaultTemplates[key][language], isCustomized: false };
};
