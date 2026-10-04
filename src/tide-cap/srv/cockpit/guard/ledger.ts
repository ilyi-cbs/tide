// Budget ledger (P-15): one row per ledger, shared across processes through
// the database. The check before a call is an atomic conditional update (the
// row only matches while used + estimate <= limit); recording is an atomic
// increment. Dry runs are checked like real calls but never recorded.
import cds from "@sap/cds";
import { budgetLimit } from "./domain/logic";
import { round as roundTo } from "../kernel/stats";
import { budgetLimitInputs } from "../../core/config";

const round = (x: number) => roundTo(x, 4);

const { SELECT, INSERT, UPDATE } = cds.ql;
const LEDGER = "tide.cockpit.BudgetLedger";
const ENTRY = "tide.cockpit.BudgetEntry";
const LOG = cds.log("cockpit");
export const LEDGER_ID = "default";

export function limit(): number {
  const { env, configured } = budgetLimitInputs();
  return budgetLimit(env, configured);
}

/** Ledger work runs in its own root transaction, independent of the caller's. */
const own = <T>(fn: () => Promise<T>) => cds.tx({ user: new cds.User.Privileged() } as any, fn);

async function ensureRow() {
  const row = await SELECT.one.from(LEDGER).where({ ID: LEDGER_ID });
  if (row) return row;
  try {
    await INSERT.into(LEDGER).entries({ ID: LEDGER_ID, calls: 0, costUnits: 0, updatedAt: new Date().toISOString() });
  } catch {
    // Another process created it first.
  }
  return SELECT.one.from(LEDGER).where({ ID: LEDGER_ID });
}

async function log(kind: string, label: string, calls: number, costUnits: number) {
  const last = await SELECT.one.from(ENTRY).columns("max(seq) as seq");
  await INSERT.into(ENTRY).entries({
    seq: (last?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    userId: cds.context?.user?.id ?? null,
    label: label.slice(0, 200),
    calls,
    costUnits,
    kind,
  });
}

export class BudgetExceeded extends Error {
  status = 429;
  code = "BUDGET_EXCEEDED";
  constructor(
    readonly used: number,
    readonly estimate: number,
    readonly max: number,
  ) {
    super(`Budget reached: ${round(used)} of ${round(max)} cost units used, this step needs about ${round(estimate)}.`);
  }
}

/** Refuses (429) when the estimate does not fit into the remaining budget. Writes nothing on success. */
export async function check(label: string, costUnits: number) {
  const max = limit();
  const est = Math.max(0, costUnits || 0);
  const refused = await own(async () => {
    await ensureRow();
    // Atomic: the row matches only while the estimate fits (and, for calls
    // without an estimate, while anything is left).
    const q = UPDATE.entity(LEDGER).with({ updatedAt: new Date().toISOString() });
    const n = await (est > 0
      ? q.where`ID = ${LEDGER_ID} and costUnits + ${est} <= ${max}`
      : q.where`ID = ${LEDGER_ID} and costUnits < ${max}`);
    if (n) return null;
    const row = await SELECT.one.from(LEDGER).where({ ID: LEDGER_ID });
    await log("refused", label, 0, est);
    return row;
  });
  if (refused) throw new BudgetExceeded(refused.costUnits ?? 0, est, max);
}

/** Adds used calls and cost units (atomic increment). */
export async function record(label: string, calls: number, costUnits: number) {
  if (!calls && !costUnits) return;
  await own(async () => {
    await ensureRow();
    await UPDATE.entity(LEDGER)
      .with({
        calls: { "+=": Math.round(calls || 0) },
        costUnits: { "+=": Math.max(0, costUnits || 0) },
        updatedAt: new Date().toISOString(),
      })
      .where({ ID: LEDGER_ID });
    await log("record", label, calls, costUnits);
  }).catch((e) => LOG.warn("budget ledger not updated:", e));
}

export async function state() {
  const row = await own(ensureRow);
  const max = limit();
  const used = row?.costUnits ?? 0;
  return { calls: row?.calls ?? 0, costUnits: round(used), limit: max, remaining: round(Math.max(0, max - used)) };
}
