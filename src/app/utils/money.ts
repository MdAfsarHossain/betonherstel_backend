// Money maths for quotations, and later invoices. Amounts are worked out in whole
// cents (integers) so there is never a floating-point error such as 0.1 + 0.2.
// Rounding is "half away from zero" to the cent, the usual rule on Dutch invoices.
// (BigInt() calls rather than 0n literals: the project compiles for ES2016.)

const ZERO = BigInt(0);
const TWO = BigInt(2);
const THOUSAND = BigInt(1000);
const TEN_THOUSAND = BigInt(10000);

// True when `value` has at most `decimals` decimal places (e.g. 19.99, not 19.999)
export const hasMaxDecimals = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.abs(value * factor - Math.round(value * factor)) < 1e-6;
};

export const toCents = (amount: number) => Math.round(amount * 100);

export const fromCents = (cents: number) => cents / 100;

// Integer division that rounds half away from zero
const roundDiv = (numerator: bigint, denominator: bigint) => {
  const negative = numerator < ZERO;
  const abs = negative ? -numerator : numerator;
  const quotient = (abs + denominator / TWO) / denominator;
  return negative ? -quotient : quotient;
};

// quantity (up to 3 decimals) x unit price in cents -> cents
export const lineAmountCents = (quantity: number, unitPriceCents: number) =>
  Number(roundDiv(BigInt(Math.round(quantity * 1000)) * BigInt(unitPriceCents), THOUSAND));

// VAT in cents for an amount in cents at a percentage (up to 2 decimals, e.g. 21 or 6.5)
export const vatCents = (baseCents: number, ratePercent: number) =>
  Number(roundDiv(BigInt(baseCents) * BigInt(Math.round(ratePercent * 100)), TEN_THOUSAND));
