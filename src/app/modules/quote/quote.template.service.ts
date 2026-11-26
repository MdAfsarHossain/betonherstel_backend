import httpStatus from "http-status";
import ApiError from "../../errors/ApiError";
import assertUuid from "../../utils/assertUuid";
import { logAudit } from "../../utils/audit";
import { query, transaction } from "../../utils/db";
import { IUpsertQuoteTemplate } from "./quote.interface";

// Reusable quotation texts per service type and language (FR-QUO-05): introduction,
// scope, conditions and warranty. A template without a service type is the general
// text for that language. A new quotation starts from the one for its service type
// and language, with the general text filling any gap.

const templateColumns = `
  t.id,
  t.language,
  t.intro_text,
  t.scope_text,
  t.conditions_text,
  t.warranty_text,
  CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object(
    'id', st.id, 'key', st.key, 'label_nl', st.label_nl, 'label_en', st.label_en
  ) END AS service_type,
  t.created_at AS "createdAt",
  t.updated_at AS "updatedAt"
`;

const clean = (value?: string | null) =>
  typeof value === "string"
    ? value.trim() === ""
      ? null
      : value.trim()
    : null;

const getTemplates = async () => {
  const result = await query(
    `
        SELECT ${templateColumns}
        FROM quote_templates t
        LEFT JOIN service_types st ON st.id = t.service_type_id
        ORDER BY (t.service_type_id IS NULL) DESC, st.sort_order ASC, t.language ASC
    `,
  );
  return result.rows;
};

// Create or replace the texts for a service type + language
const upsertTemplate = async (
  payload: IUpsertQuoteTemplate,
  actorId: string,
) => {
  let serviceTypeId: string | null = null;
  if (payload.service_type) {
    const st = await query(`SELECT id FROM service_types WHERE key = $1`, [
      payload.service_type,
    ]);
    if (st.rows.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Unknown service type!");
    }
    serviceTypeId = st.rows[0].id;
  }

  const id = await transaction(async (client) => {
    const result = await client.query(
      `
        INSERT INTO quote_templates (
            service_type_id, language, intro_text, scope_text, conditions_text, warranty_text, updated_by
        ) VALUES ($1::uuid, $2::"Language", $3, $4, $5, $6, $7::uuid)
        ON CONFLICT (COALESCE(service_type_id, '00000000-0000-0000-0000-000000000000'::uuid), language)
        DO UPDATE SET intro_text = EXCLUDED.intro_text, scope_text = EXCLUDED.scope_text,
                      conditions_text = EXCLUDED.conditions_text, warranty_text = EXCLUDED.warranty_text,
                      updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `,
      [
        serviceTypeId,
        payload.language,
        clean(payload.intro_text),
        clean(payload.scope_text),
        clean(payload.conditions_text),
        clean(payload.warranty_text),
        actorId,
      ],
    );
    await logAudit(
      {
        actor_id: actorId,
        action: "UPDATE",
        entity_type: "quote_template",
        entity_id: result.rows[0].id,
        changes: {
          service_type: payload.service_type ?? null,
          language: payload.language,
        },
      },
      client,
    );
    return result.rows[0].id as string;
  });

  const row = await query(
    `SELECT ${templateColumns} FROM quote_templates t LEFT JOIN service_types st ON st.id = t.service_type_id WHERE t.id = $1::uuid`,
    [id],
  );
  return row.rows[0];
};

const deleteTemplate = async (id: string, actorId: string) => {
  assertUuid(id, "template id");

  await transaction(async (client) => {
    const result = await client.query(
      `DELETE FROM quote_templates WHERE id = $1::uuid RETURNING id`,
      [id],
    );
    if (result.rows.length === 0) {
      throw new ApiError(httpStatus.NOT_FOUND, "Template not found!");
    }
    await logAudit(
      {
        actor_id: actorId,
        action: "DELETE",
        entity_type: "quote_template",
        entity_id: id,
      },
      client,
    );
  });
};

// The texts a new quotation starts with: the template for its service type, with
// the general template for the language filling any field it leaves empty
const getStartingTexts = async (
  serviceTypeId: string | null,
  language: string,
  client?: any,
) => {
  const run = client ? client.query.bind(client) : query;
  const result = await run(
    `
        SELECT intro_text, scope_text, conditions_text, warranty_text
        FROM quote_templates
        WHERE language = $1::"Language" AND (service_type_id = $2::uuid OR service_type_id IS NULL)
        ORDER BY (service_type_id IS NULL) ASC
    `,
    [language, serviceTypeId],
  );

  const pick = (field: string) => {
    for (const row of result.rows) {
      if (row[field]) return row[field] as string;
    }
    return null;
  };

  return {
    intro_text: pick("intro_text"),
    scope_text: pick("scope_text"),
    conditions_text: pick("conditions_text"),
    warranty_text: pick("warranty_text"),
  };
};

export const QuoteTemplateService = {
  getTemplates,
  upsertTemplate,
  deleteTemplate,
  getStartingTexts,
};
