// Small helpers for the dynamic INSERT / UPDATE queries used across modules.
// `allowed` maps a column name to an optional SQL cast (e.g. '::"Role"').
// Column names only ever come from these whitelists, never from user input.
export type TFieldCasts = Record<string, string>;

// Builds `col = $n` fragments for the whitelisted fields present in the payload.
// A field set to `null` is written as NULL; an `undefined` field is skipped.
export const buildUpdate = (
  payload: Record<string, any>,
  allowed: TFieldCasts,
  startParam = 1,
) => {
  const updates: string[] = [];
  const values: any[] = [];
  let paramCount = startParam;

  for (const [field, cast] of Object.entries(allowed)) {
    if (payload[field] !== undefined) {
      updates.push(`${field} = $${paramCount++}${cast}`);
      values.push(payload[field]);
    }
  }

  return { updates, values, paramCount };
};

// Builds the column / placeholder lists for the whitelisted fields present in the payload
export const buildInsert = (
  payload: Record<string, any>,
  allowed: TFieldCasts,
  startParam = 1,
) => {
  const columns: string[] = [];
  const placeholders: string[] = [];
  const values: any[] = [];
  let paramCount = startParam;

  for (const [field, cast] of Object.entries(allowed)) {
    if (payload[field] !== undefined) {
      columns.push(field);
      placeholders.push(`$${paramCount++}${cast}`);
      values.push(payload[field]);
    }
  }

  return { columns, placeholders, values, paramCount };
};
