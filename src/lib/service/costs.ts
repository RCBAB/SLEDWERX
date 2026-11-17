// Cost maths in whole cents, so totals match the database view
// (maintenance_entry_costs) without floating-point drift.

const toCents = (value: number | null | undefined) => Math.round((value ?? 0) * 100);

export type CostPart = { quantity: number; unitCost?: number | null };

/** quantity x unit cost, in dollars, rounded to the cent. */
export function partLineTotal(part: CostPart): number {
  return Math.round(part.quantity * toCents(part.unitCost)) / 100;
}

export function serviceCosts(input: { parts: CostPart[]; laborCost?: number | null; otherCost?: number | null }) {
  const partsCents = input.parts.reduce((sum, part) => sum + Math.round(part.quantity * toCents(part.unitCost)), 0);
  const laborCents = toCents(input.laborCost);
  const otherCents = toCents(input.otherCost);
  return {
    parts: partsCents / 100,
    labor: laborCents / 100,
    other: otherCents / 100,
    total: (partsCents + laborCents + otherCents) / 100,
  };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatUsd(value: number | null | undefined): string {
  return usd.format(value ?? 0);
}
