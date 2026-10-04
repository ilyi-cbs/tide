// Ingest hook registry (contract §7). Features register hooks in register();
// feed calls runHooks after upserting the ingested rows into tide.s4.
// Order per kind = step order (A1), independent of registration timing.
import cds from "@sap/cds";
import { STEP_ORDER } from "./steps";
import type { EventRow, Hook, IngestEvent, IngestKind, StepContext } from "./types";

const LOG = cds.log("cockpit");

interface Entry {
  kind: IngestKind;
  name: string;
  hook: Hook;
  seq: number;
}
const registry: Entry[] = [];
let counter = 0;

const orderOf = (name: string) => {
  const feature = name.split(/[.:/]/)[0];
  const i = (STEP_ORDER as readonly string[]).indexOf(feature);
  return i < 0 ? STEP_ORDER.length : i;
};

/**
 * Registers a hook. `name` starts with the feature folder (e.g.
 * "impact.recompute"); re-registering the same kind + name replaces it.
 */
export function registerHook(kind: IngestKind, name: string, hook: Hook) {
  const i = registry.findIndex((e) => e.kind === kind && e.name === name);
  const entry = { kind, name, hook, seq: i >= 0 ? registry[i].seq : counter++ };
  if (i >= 0) registry[i] = entry;
  else registry.push(entry);
}

export function hooksFor(kind: IngestKind): { name: string; hook: Hook }[] {
  return registry
    .filter((e) => e.kind === kind)
    .sort((a, b) => orderOf(a.name) - orderOf(b.name) || a.seq - b.seq)
    .map(({ name, hook }) => ({ name, hook }));
}

/**
 * True when the caller's context has a database transaction that has already
 * started (it holds a connection; SQLite has exactly one).
 */
function callerHoldsDb(): boolean {
  const txs: Map<unknown, any> | undefined = (cds.context as any)?.transactions;
  const db = cds.db as unknown;
  const tx = db && txs?.get(db);
  return !!tx && !!tx.ready && tx.ready !== "committed" && tx.ready !== "rolled back";
}

/**
 * Runs the hooks of ev.kind in order; a failing hook is logged and skipped.
 * Returns their events.
 *
 * Transactions: every hook runs outside the caller's transaction, in a fresh
 * context of its own (same user and tenant, no transaction). Its writes go
 * through inTx, i.e. short root transactions of their own (cds.tx), and a
 * model run it waits for (callCore/awaitRun) is polled in root transactions
 * too, so no transaction is held while a hook waits for a model run. One
 * cds.tx around the whole hook is avoided on purpose: on SQLite (one
 * connection) it would hold the connection the queue worker running the
 * prediction needs. Callers should call runHooks after their own writes are
 * committed. If the caller's database transaction has already started, a
 * fresh transaction could not get a connection (deadlock on SQLite), so the
 * hooks fall back to the caller's transaction and a warning is logged.
 */
export async function runHooks(ev: IngestEvent, ctx: StepContext): Promise<Array<Partial<EventRow>>> {
  const events: Array<Partial<EventRow>> = [];
  const shared = callerHoldsDb();
  if (shared)
    LOG.warn(`runHooks (${ev.kind}) called inside an open database transaction; hooks share it`);
  for (const { name, hook } of hooksFor(ev.kind)) {
    try {
      const r = shared ? await hook(ev, ctx) : await detached(ctx, () => hook(ev, ctx));
      if (r?.events) events.push(...r.events);
    } catch (e) {
      LOG.error(`hook ${name} (${ev.kind}) failed`, e);
    }
  }
  return events;
}

/** Runs fn in a new event context without a transaction (user and tenant kept). */
function detached<T>(ctx: StepContext, fn: () => Promise<T>): Promise<T> {
  const context = new (cds.EventContext as any)({ user: ctx.user, tenant: cds.context?.tenant });
  return (cds as any)._with(context, fn);
}

/** Tests only. */
export function resetHooks() {
  registry.length = 0;
}
