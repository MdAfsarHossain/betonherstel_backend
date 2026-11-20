import config from "../../../config";
import { query, transaction } from "../../utils/db";
import { sendTemplatedEmail } from "../../utils/email/emailService";
import { formatDate, formatMoney } from "../../utils/formatters";
import { toLanguage } from "../../utils/i18n";
import { ActionJobs } from "../actions/actions.jobs";
import { RelationService } from "../relation/relation.service";
import { SettingsService } from "../settings/settings.service";

// Scheduled work on quotations. server.ts runs these on a timer; an admin can also
// trigger them with POST /quotes/jobs/run (for example from an external scheduler).
// Both are safe to run as often as you like: they only act on what is due.

// Sent quotations past their validity date become "Verlopen" (FR-QUO-09)
const expireOverdueQuotes = async () => {
  return transaction(async (client) => {
    const expired = await client.query(
      `
        UPDATE quotes
        SET status = 'EXPIRED', expired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'SENT' AND is_current
          AND valid_until < (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Amsterdam')::date
        RETURNING id, number, revision, relation_id
      `,
    );

    for (const quote of expired.rows) {
      await RelationService.logRelationEvent(
        quote.relation_id,
        {
          event_type: "QUOTE_EXPIRED",
          entity_type: "quote",
          entity_id: quote.id,
          title: `Quotation ${quote.number} expired`,
        },
        client,
      );
    }

    return expired.rows.length;
  });
};

// A sent quotation with no answer after `quote_followup_days` gets one reminder
// (FR-QUO-12): it is flagged, logged on the customer's timeline and the responsible
// office user is emailed. It also creates a task (Acties module).
const sendFollowUpReminders = async () => {
  const company = await SettingsService.getCompanySettings();
  const days: number = company.quote_followup_days;

  const due = await query(
    `
      SELECT id FROM quotes
      WHERE status = 'SENT' AND is_current AND follow_up_reminded_at IS NULL
        AND sent_at <= CURRENT_TIMESTAMP - make_interval(days => $1)
    `,
    [days],
  );
  if (due.rows.length === 0) return 0;

  // Claiming them first means two runs at the same time never remind twice
  const claimed = await query(
    `
      UPDATE quotes q
      SET follow_up_reminded_at = CURRENT_TIMESTAMP
      FROM relations r
      WHERE r.id = q.relation_id AND q.id = ANY($1::uuid[])
        AND q.status = 'SENT' AND q.follow_up_reminded_at IS NULL
      RETURNING q.id, q.number, q.title, q.language, q.relation_id, q.sent_at, q.created_by,
                q.total_incl_vat::float8 AS total_incl_vat, r.name AS relation_name
    `,
    [due.rows.map((r) => r.id)],
  );

  for (const quote of claimed.rows) {
    await RelationService.logRelationEvent(quote.relation_id, {
      event_type: "QUOTE_FOLLOW_UP_DUE",
      entity_type: "quote",
      entity_id: quote.id,
      title: `Quotation ${quote.number}: no answer after ${days} days, follow up`,
    });

    // ...and a task for the person who made it, or for the team (FR-QUO-12)
    await ActionJobs.createQuoteFollowUp({
      id: quote.id,
      number: quote.number,
      title: quote.title,
      relation_name: quote.relation_name,
      created_by: quote.created_by,
      days: Math.floor((Date.now() - new Date(quote.sent_at).getTime()) / 86_400_000),
    });

    // The person who made it, if still active in the office; otherwise the whole office
    const owner = await query(
      `SELECT id, email, preferred_language FROM users
       WHERE id = $1::uuid AND is_active AND status = 'ACTIVE' AND role IN ('SUPERADMIN', 'ADMIN', 'OFFICE')`,
      [quote.created_by],
    );
    const recipients =
      owner.rows.length > 0
        ? owner.rows
        : (
            await query(
              `SELECT id, email, preferred_language FROM users
               WHERE is_active AND status = 'ACTIVE' AND role IN ('ADMIN', 'OFFICE')`,
            )
          ).rows;

    await Promise.allSettled(
      recipients.map((user) => {
        const language = toLanguage(user.preferred_language);
        return sendTemplatedEmail({
          to: user.email,
          templateKey: "quote_follow_up",
          language,
          variables: {
            name: quote.relation_name,
            quote_number: quote.number,
            title: quote.title,
            total: formatMoney(quote.total_incl_vat, language),
            sent_date: formatDate(quote.sent_at, language),
            // How long it has actually been waiting, not the configured threshold
            days: Math.floor((Date.now() - new Date(quote.sent_at).getTime()) / 86_400_000),
            link: `${config.frontend_url}/quotes/${quote.id}`,
          },
          related: { type: "quote", id: quote.id },
        });
      }),
    );
  }

  return claimed.rows.length;
};

const runScheduledJobs = async () => ({
  expired: await expireOverdueQuotes(),
  follow_ups: await sendFollowUpReminders(),
});

export const QuoteJobs = {
  expireOverdueQuotes,
  sendFollowUpReminders,
  runScheduledJobs,
};
