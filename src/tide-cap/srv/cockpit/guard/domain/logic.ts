// Pure logic of the guard feature (no CDS imports): buyers derived from the
// data, the scope of a user, and the budget ledger's limit resolution (P-15).

/** Default ledger limit in cost units when neither config nor env set one. */
export const DEFAULT_LIMIT = 50;

/** Limit: env TIDE_BUDGET wins over cds.env.cockpit.budget.costUnits; invalid values fall back. */
export function budgetLimit(env: string | undefined, configured: unknown): number {
  for (const v of [env, configured]) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_LIMIT;
}

export interface BuyerRow {
  userId: string;
  name: string;
  PurchasingGroup: string;
  Plant: string | null;
}

/** Mocked user id of the buyer of a purchasing group. */
export const buyerId = (group: string) => `buyer${group}`;

/**
 * One buyer per purchasing group found in the order book. Name from the
 * purchasing group master (I_PurchasingGroup) when loaded, else "Buyer <PG>".
 * Plant: the group's plant when it orders for exactly one, else null (all).
 */
export function deriveBuyers(
  items: { PurchasingGroup?: string | null; Plant?: string | null }[],
  names: Map<string, string> = new Map(),
): BuyerRow[] {
  const plants = new Map<string, Set<string>>();
  for (const i of items) {
    const g = i.PurchasingGroup?.trim();
    if (!g) continue;
    const set = plants.get(g) ?? plants.set(g, new Set()).get(g)!;
    if (i.Plant) set.add(i.Plant);
  }
  return [...plants.keys()].sort().map((g) => {
    const p = [...plants.get(g)!];
    return {
      userId: buyerId(g),
      name: names.get(g)?.trim() || `Buyer ${g}`,
      PurchasingGroup: g,
      Plant: p.length === 1 ? p[0] : null,
    };
  });
}

export { scopeOf, inScope, type Scope } from "../../kernel/auth";

/** Mocked users for package.json cds.requires.auth.users. */
export function mockedUsers(buyers: BuyerRow[]) {
  const out: Record<string, any> = {};
  for (const b of buyers)
    out[b.userId] = {
      password: b.userId,
      roles: ["user"],
      attr: { PurchasingGroup: b.PurchasingGroup, ...(b.Plant ? { Plant: b.Plant } : {}) },
    };
  return out;
}
