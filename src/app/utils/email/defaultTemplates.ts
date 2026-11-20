import { TLanguage } from "../i18n";

// Built-in email templates (FR-SET-03). The Beheerder can override any of them
// in Settings; deleting the override restores these. Merge fields use {{name}}.
// {{company_name}} is always available.

export interface IEmailTemplate {
  subject: string;
  body_html: string;
}

export const templateKeys = [
  "password_reset",
  "portal_invitation",
  "inquiry_confirmation",
  "new_inquiry",
  "appointment_confirmation",
  "quote",
  "quote_follow_up",
  "invoice",
  "invoice_reminder",
  "work_order",
  "work_order_completed",
  "credit_note",
  "purchase_order",
  "subcontract_assignment",
  "notification",
  "portal_message",
  "subcontractor_invitation",
  "direct_debit_setup",
  "invoice_direct_debit",
  "direct_debit_failed",
] as const;

export type TTemplateKey = (typeof templateKeys)[number];

// Merge fields each template is given by the code that sends it
export const templateVariables: Record<TTemplateKey, string[]> = {
  password_reset: ["name", "link", "expires_minutes"],
  portal_invitation: ["name", "link"],
  inquiry_confirmation: ["name", "reference", "service"],
  // Internal: sent to the office when an inquiry arrives
  new_inquiry: [
    "name",
    "email",
    "phone",
    "reference",
    "service",
    "source",
    "contact",
    "description",
    "link",
  ],
  appointment_confirmation: ["name", "appointment_type", "when", "address", "title"],
  quote: ["name", "quote_number", "title", "total", "valid_until", "link"],
  // Internal: reminds the office that a sent quotation has had no answer
  quote_follow_up: ["name", "quote_number", "title", "total", "sent_date", "days", "link"],
  invoice: ["name", "invoice_number", "total", "due_date", "payment_link", "link"],
  invoice_reminder: ["name", "invoice_number", "total", "due_date", "payment_link"],
  work_order: ["name", "work_order_number", "project", "date"],
  // Internal: sent to the office when the crew has completed a work order (FR-WO-06)
  work_order_completed: ["name", "work_order_number", "project", "crew", "completed_at", "link"],
  credit_note: ["name", "credit_note_number", "total", "original_number", "link"],
  // Sent to the supplier with the purchase order PDF attached (FR-PUR-02)
  purchase_order: ["name", "purchase_order_number", "project", "expected_delivery", "total"],
  // Sent to the subcontractor with the work instruction PDF attached (FR-SUB-02)
  subcontract_assignment: ["name", "assignment_number", "project", "planned_start", "planned_end", "price", "link"],
  // Internal: the email copy of an in-app notification, when the employee asked for it (FR-MSG-05)
  notification: ["name", "title", "body", "link"],
  // Sent to the customer's portal users when the office replies on a project (FR-PORT-08)
  portal_message: ["name", "project", "message", "link"],
  subcontractor_invitation: ["name", "link"],
  // Subscriptions (FR-ABO-03, FR-ABO-05)
  direct_debit_setup: ["name", "link"],
  invoice_direct_debit: ["name", "invoice_number", "total", "due_date", "link"],
  direct_debit_failed: ["name", "invoice_number", "amount", "reason", "payment_link"],
};

const p = (text: string) => `<p style="margin:0 0 16px 0;">${text}</p>`;
const button = (label: string, href: string) =>
  `<p style="margin:24px 0;"><a href="${href}" style="background:#1e3a5f;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">${label}</a></p>`;

export const defaultTemplates: Record<TTemplateKey, Record<TLanguage, IEmailTemplate>> = {
  password_reset: {
    NL: {
      subject: "Wachtwoord opnieuw instellen",
      body_html:
        p("Beste {{name}},") +
        p("U heeft gevraagd om uw wachtwoord opnieuw in te stellen. Klik op de knop hieronder. Deze link is {{expires_minutes}} minuten geldig.") +
        button("Wachtwoord instellen", "{{link}}") +
        p("Heeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren; uw wachtwoord blijft ongewijzigd."),
    },
    EN: {
      subject: "Reset your password",
      body_html:
        p("Dear {{name}},") +
        p("You asked to reset your password. Click the button below. This link is valid for {{expires_minutes}} minutes.") +
        button("Set password", "{{link}}") +
        p("If you did not request this, you can ignore this email; your password stays unchanged."),
    },
  },
  portal_invitation: {
    NL: {
      subject: "Uitnodiging voor het klantportaal van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("{{company_name}} nodigt u uit voor uw persoonlijke portaal. Hier ziet u uw offertes, projecten en facturen en kunt u direct reageren en betalen.") +
        button("Account aanmaken", "{{link}}"),
    },
    EN: {
      subject: "Invitation to the {{company_name}} portal",
      body_html:
        p("Dear {{name}},") +
        p("{{company_name}} invites you to your personal portal, where you can see your quotations, projects and invoices, reply and pay online.") +
        button("Create account", "{{link}}"),
    },
  },
  inquiry_confirmation: {
    NL: {
      subject: "We hebben uw aanvraag ontvangen ({{reference}})",
      body_html:
        p("Beste {{name}},") +
        p("Bedankt voor uw aanvraag voor {{service}}. We hebben deze ontvangen onder referentie <strong>{{reference}}</strong> en nemen zo snel mogelijk contact met u op.") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "We received your request ({{reference}})",
      body_html:
        p("Dear {{name}},") +
        p("Thank you for your request for {{service}}. We received it under reference <strong>{{reference}}</strong> and will contact you as soon as possible.") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  new_inquiry: {
    NL: {
      subject: "Nieuwe aanvraag {{reference}}: {{service}}",
      body_html:
        p("Er is een nieuwe aanvraag binnengekomen.") +
        p("<strong>{{reference}}</strong><br/>Klant: {{name}}<br/>Dienst: {{service}}<br/>Bron: {{source}}<br/>Contact: {{contact}}") +
        p("{{description}}") +
        button("Aanvraag openen", "{{link}}"),
    },
    EN: {
      subject: "New inquiry {{reference}}: {{service}}",
      body_html:
        p("A new inquiry has arrived.") +
        p("<strong>{{reference}}</strong><br/>Customer: {{name}}<br/>Service: {{service}}<br/>Source: {{source}}<br/>Contact: {{contact}}") +
        p("{{description}}") +
        button("Open inquiry", "{{link}}"),
    },
  },
  appointment_confirmation: {
    NL: {
      subject: "Bevestiging afspraak: {{appointment_type}} op {{when}}",
      body_html:
        p("Beste {{name}},") +
        p("Hierbij bevestigen wij de volgende afspraak:") +
        p("<strong>{{appointment_type}}</strong><br/>Wanneer: {{when}}<br/>Adres: {{address}}") +
        p("De afspraak staat als agenda-bestand in de bijlage. Moet u de afspraak verplaatsen? Neem dan contact met ons op.") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Appointment confirmation: {{appointment_type}} on {{when}}",
      body_html:
        p("Dear {{name}},") +
        p("We confirm the following appointment:") +
        p("<strong>{{appointment_type}}</strong><br/>When: {{when}}<br/>Address: {{address}}") +
        p("The appointment is attached as a calendar file. Need to reschedule? Please contact us.") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  quote: {
    NL: {
      subject: "Offerte {{quote_number}} van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("Hierbij ontvangt u offerte <strong>{{quote_number}}</strong> voor {{title}}, ter waarde van {{total}} en geldig tot {{valid_until}}. De offerte zit als PDF in de bijlage en staat ook in uw portaal, waar u deze direct kunt accepteren.") +
        button("Offerte bekijken", "{{link}}") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Quotation {{quote_number}} from {{company_name}}",
      body_html:
        p("Dear {{name}},") +
        p("Please find quotation <strong>{{quote_number}}</strong> for {{title}}, worth {{total}} and valid until {{valid_until}}. It is attached as a PDF and available in your portal, where you can accept it online.") +
        button("View quotation", "{{link}}") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  quote_follow_up: {
    NL: {
      subject: "Opvolgen: offerte {{quote_number}} van {{name}}",
      body_html:
        p("Offerte <strong>{{quote_number}}</strong> ({{title}}) voor {{name}} ter waarde van {{total}} is op {{sent_date}} verstuurd en nog niet beantwoord ({{days}} dagen).") +
        p("Neem contact op met de klant om te vragen of er vragen zijn.") +
        button("Offerte openen", "{{link}}"),
    },
    EN: {
      subject: "Follow up: quotation {{quote_number}} for {{name}}",
      body_html:
        p("Quotation <strong>{{quote_number}}</strong> ({{title}}) for {{name}}, worth {{total}}, was sent on {{sent_date}} and has not been answered yet ({{days}} days).") +
        p("Contact the customer to ask whether they have any questions.") +
        button("Open quotation", "{{link}}"),
    },
  },
  invoice: {
    NL: {
      subject: "Factuur {{invoice_number}} van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("Hierbij ontvangt u factuur <strong>{{invoice_number}}</strong> van {{total}}. Wij verzoeken u te betalen vóór {{due_date}}.") +
        button("Nu betalen", "{{payment_link}}") +
        p("De factuur zit als PDF in de bijlage en staat ook in uw portaal.") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Invoice {{invoice_number}} from {{company_name}}",
      body_html:
        p("Dear {{name}},") +
        p("Please find invoice <strong>{{invoice_number}}</strong> for {{total}}. Please pay before {{due_date}}.") +
        button("Pay now", "{{payment_link}}") +
        p("The invoice is attached as a PDF and available in your portal.") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  invoice_reminder: {
    NL: {
      subject: "Betalingsherinnering factuur {{invoice_number}}",
      body_html:
        p("Beste {{name}},") +
        p("Onze administratie ziet dat factuur <strong>{{invoice_number}}</strong> van {{total}} nog niet is betaald. De vervaldatum was {{due_date}}. Mocht u inmiddels betaald hebben, dan kunt u deze e-mail negeren.") +
        button("Nu betalen", "{{payment_link}}") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Payment reminder for invoice {{invoice_number}}",
      body_html:
        p("Dear {{name}},") +
        p("Our records show that invoice <strong>{{invoice_number}}</strong> for {{total}} has not been paid yet. The due date was {{due_date}}. If you have already paid, please ignore this email.") +
        button("Pay now", "{{payment_link}}") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  work_order: {
    NL: {
      subject: "Werkbon {{work_order_number}} voor {{project}}",
      body_html:
        p("Beste {{name}},") +
        p("In de bijlage vindt u de afgeronde werkbon <strong>{{work_order_number}}</strong> voor {{project}} van {{date}}.") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Work order {{work_order_number}} for {{project}}",
      body_html:
        p("Dear {{name}},") +
        p("Attached is the completed work order <strong>{{work_order_number}}</strong> for {{project}} dated {{date}}.") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  work_order_completed: {
    NL: {
      subject: "Werkbon {{work_order_number}} is afgerond",
      body_html:
        p("Hallo {{name}},") +
        p("Werkbon <strong>{{work_order_number}}</strong> voor project {{project}} is afgerond door {{crew}} op {{completed_at}}. Controleer de werkbon en markeer deze als gecontroleerd.") +
        button("Werkbon bekijken", "{{link}}") +
        p("{{company_name}}"),
    },
    EN: {
      subject: "Work order {{work_order_number}} has been completed",
      body_html:
        p("Hello {{name}},") +
        p("Work order <strong>{{work_order_number}}</strong> for project {{project}} was completed by {{crew}} on {{completed_at}}. Please review it and mark it as checked.") +
        button("View work order", "{{link}}") +
        p("{{company_name}}"),
    },
  },
  credit_note: {
    NL: {
      subject: "Creditnota {{credit_note_number}} van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("Hierbij ontvangt u creditnota <strong>{{credit_note_number}}</strong> van {{total}} bij factuur {{original_number}}.") +
        p("De creditnota zit als PDF in de bijlage en staat ook in uw portaal.") +
        button("Creditnota bekijken", "{{link}}") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Credit note {{credit_note_number}} from {{company_name}}",
      body_html:
        p("Dear {{name}},") +
        p("Please find credit note <strong>{{credit_note_number}}</strong> for {{total}} against invoice {{original_number}}.") +
        p("The credit note is attached as a PDF and available in your portal.") +
        button("View credit note", "{{link}}") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  purchase_order: {
    NL: {
      subject: "Inkooporder {{purchase_order_number}} van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("Hierbij ontvangt u onze inkooporder <strong>{{purchase_order_number}}</strong> ter waarde van {{total}}. Project: {{project}}. Gewenste leverdatum: {{expected_delivery}}.") +
        p("De inkooporder zit als PDF in de bijlage. Wilt u de order bevestigen en de leverdatum doorgeven?") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Purchase order {{purchase_order_number}} from {{company_name}}",
      body_html:
        p("Dear {{name}},") +
        p("Please find our purchase order <strong>{{purchase_order_number}}</strong> for {{total}}. Project: {{project}}. Requested delivery date: {{expected_delivery}}.") +
        p("The purchase order is attached as a PDF. Could you confirm the order and the delivery date?") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  subcontract_assignment: {
    NL: {
      subject: "Werkopdracht {{assignment_number}} van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("Hierbij ontvangt u werkopdracht <strong>{{assignment_number}}</strong> voor project {{project}}. Geplande uitvoering: {{planned_start}} tot {{planned_end}}. Afgesproken prijs: {{price}} excl. btw.") +
        p("De werkopdracht zit als PDF in de bijlage. Wilt u de opdracht bevestigen of afwijzen? U kunt ook een alternatieve datum voorstellen.") +
        button("Bekijk de opdracht", "{{link}}") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Work instruction {{assignment_number}} from {{company_name}}",
      body_html:
        p("Dear {{name}},") +
        p("Please find work instruction <strong>{{assignment_number}}</strong> for project {{project}}. Planned execution: {{planned_start}} to {{planned_end}}. Agreed price: {{price}} excl. VAT.") +
        p("The work instruction is attached as a PDF. Could you confirm or decline it? You can also propose an alternative date.") +
        button("View the assignment", "{{link}}") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  notification: {
    NL: {
      subject: "{{title}}",
      body_html:
        p("Beste {{name}},") +
        p("<strong>{{title}}</strong>") +
        p("{{body}}") +
        button("Openen", "{{link}}") +
        p("Je ontvangt dit bericht omdat je e-mailmeldingen hebt ingeschakeld. Je kunt dit aanpassen in je meldingsinstellingen.") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "{{title}}",
      body_html:
        p("Dear {{name}},") +
        p("<strong>{{title}}</strong>") +
        p("{{body}}") +
        button("Open", "{{link}}") +
        p("You receive this because you turned on email notifications. You can change this in your notification settings.") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  portal_message: {
    NL: {
      subject: "Nieuw bericht over {{project}} van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("Er is een nieuw bericht over uw project <strong>{{project}}</strong>:") +
        p("{{message}}") +
        button("Bekijk en reageer", "{{link}}") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "New message about {{project}} from {{company_name}}",
      body_html:
        p("Dear {{name}},") +
        p("There is a new message about your project <strong>{{project}}</strong>:") +
        p("{{message}}") +
        button("View and reply", "{{link}}") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  subcontractor_invitation: {
    NL: {
      subject: "Uitnodiging voor het onderaannemersportaal van {{company_name}}",
      body_html:
        p("Beste {{name}},") +
        p("{{company_name}} nodigt u uit voor het onderaannemersportaal. Hier ontvangt en bevestigt u opdrachten, meldt u de voortgang, deelt u foto's en documenten en dient u uw facturen in.") +
        button("Account aanmaken", "{{link}}") +
        p("Met vriendelijke groet,<br/>{{company_name}}"),
    },
    EN: {
      subject: "Invitation to the {{company_name}} subcontractor portal",
      body_html:
        p("Dear {{name}},") +
        p("{{company_name}} invites you to the subcontractor portal, where you receive and confirm assignments, report progress, share photos and documents and submit your invoices.") +
        button("Create account", "{{link}}") +
        p("Kind regards,<br/>{{company_name}}"),
    },
  },
  direct_debit_setup: {
    NL: {
      subject: "Automatische incasso instellen voor uw onderhoudscontract",
      body_html:
        p("Beste {{name}},") +
        p("Met automatische incasso worden de facturen van uw onderhoudscontract automatisch van uw rekening afgeschreven. U geeft eenmalig toestemming via een kleine betaling (1 cent), bijvoorbeeld met iDEAL.") +
        button("Automatische incasso instellen", "{{link}}") +
        p("U kunt dit altijd weer wijzigen in uw klantportaal."),
    },
    EN: {
      subject: "Set up direct debit for your maintenance contract",
      body_html:
        p("Dear {{name}},") +
        p("With direct debit the invoices for your maintenance contract are collected from your account automatically. You give permission once with a very small payment (1 cent), for example through iDEAL.") +
        button("Set up direct debit", "{{link}}") +
        p("You can change this at any time in your customer portal."),
    },
  },
  invoice_direct_debit: {
    NL: {
      subject: "Factuur {{invoice_number}}: wordt automatisch geïncasseerd",
      body_html:
        p("Beste {{name}},") +
        p("Bijgevoegd vindt u factuur {{invoice_number}} voor {{total}}. Het bedrag wordt rond {{due_date}} automatisch van uw rekening geïncasseerd. U hoeft niets te doen.") +
        button("Factuur bekijken", "{{link}}"),
    },
    EN: {
      subject: "Invoice {{invoice_number}}: collected automatically",
      body_html:
        p("Dear {{name}},") +
        p("Attached is invoice {{invoice_number}} for {{total}}. The amount will be collected from your account automatically around {{due_date}}. You do not need to do anything.") +
        button("View invoice", "{{link}}"),
    },
  },
  direct_debit_failed: {
    NL: {
      subject: "Automatische incasso mislukt voor factuur {{invoice_number}}",
      body_html:
        p("Beste {{name}},") +
        p("De automatische incasso van {{amount}} voor factuur {{invoice_number}} is niet gelukt ({{reason}}). U kunt de factuur nu betalen via onderstaande link.") +
        button("Nu betalen", "{{payment_link}}"),
    },
    EN: {
      subject: "Direct debit failed for invoice {{invoice_number}}",
      body_html:
        p("Dear {{name}},") +
        p("The direct debit of {{amount}} for invoice {{invoice_number}} did not go through ({{reason}}). You can pay the invoice now with the link below.") +
        button("Pay now", "{{payment_link}}"),
    },
  },
};
