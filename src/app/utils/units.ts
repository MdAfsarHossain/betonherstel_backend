// Units used on quotation lines and catalogue items (SRS 4.7: m, m2, m3, piece, hour, lump sum)
export const units = ["m", "m2", "m3", "piece", "hour", "lump_sum"] as const;

export type TUnit = (typeof units)[number];
