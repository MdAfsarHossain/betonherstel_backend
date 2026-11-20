import { fromCents, lineAmountCents, toCents, vatCents } from "../../utils/money";

// The numbers behind a quotation (FR-QUO-04): selling price, cost price and margin
// per line and in total, and VAT per rate. Everything is calculated in cents.

export interface ICalcLine {
  quantity: number;
  unit_price: number;
  cost_price: number;
  vat_code: string;
  vat_rate: number;
  vat_reverse_charge: boolean;
}

// A single line may not exceed EUR 100 million (keeps totals far inside the database range)
export const MAX_LINE_CENTS = 100_000_000 * 100;

export const calculateLine = (line: ICalcLine) => {
  const totalCents = lineAmountCents(line.quantity, toCents(line.unit_price));
  const costCents = lineAmountCents(line.quantity, toCents(line.cost_price));
  return { totalCents, costCents, marginCents: totalCents - costCents };
};

// Margin as a percentage of the selling price, one decimal; null when nothing is sold
export const marginPercent = (marginCents: number, totalCents: number) =>
  totalCents === 0 ? null : Math.round((marginCents / totalCents) * 1000) / 10;

export const calculateTotals = (lines: ICalcLine[]) => {
  let subtotalCents = 0;
  let costCents = 0;
  const groups = new Map<string, { code: string; rate: number; reverse_charge: boolean; baseCents: number }>();

  for (const line of lines) {
    const c = calculateLine(line);
    subtotalCents += c.totalCents;
    costCents += c.costCents;

    // VAT is worked out once per rate on the sum of its lines, not per line
    const key = `${line.vat_code}|${line.vat_rate}`;
    const group = groups.get(key) ?? {
      code: line.vat_code,
      rate: line.vat_rate,
      reverse_charge: line.vat_reverse_charge,
      baseCents: 0,
    };
    group.baseCents += c.totalCents;
    groups.set(key, group);
  }

  const vat = [...groups.values()]
    .sort((a, b) => b.rate - a.rate || a.code.localeCompare(b.code))
    .map((g) => ({
      code: g.code,
      rate: g.rate,
      reverse_charge: g.reverse_charge,
      baseCents: g.baseCents,
      vatCents: g.reverse_charge ? 0 : vatCents(g.baseCents, g.rate),
    }));

  const totalVatCents = vat.reduce((sum, g) => sum + g.vatCents, 0);
  const marginCents = subtotalCents - costCents;

  return {
    subtotalCents,
    costCents,
    marginCents,
    marginPercent: marginPercent(marginCents, subtotalCents),
    vat,
    totalVatCents,
    totalCents: subtotalCents + totalVatCents,
  };
};

// The same totals as euro amounts for the API
export const totalsToAmounts = (t: ReturnType<typeof calculateTotals>) => ({
  subtotal: fromCents(t.subtotalCents),
  cost_total: fromCents(t.costCents),
  margin: fromCents(t.marginCents),
  margin_percent: t.marginPercent,
  vat: t.vat.map((g) => ({
    code: g.code,
    rate: g.rate,
    reverse_charge: g.reverse_charge,
    base: fromCents(g.baseCents),
    vat: fromCents(g.vatCents),
  })),
  total_excl_vat: fromCents(t.subtotalCents),
  total_vat: fromCents(t.totalVatCents),
  total_incl_vat: fromCents(t.totalCents),
});
