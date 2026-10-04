// Feed (P-10): ingest of arriving S/4 rows. Every step is one Event (kernel
// emit), with simulated time, source, status, model calls, cost units and
// latency.
//
// Work runs in a context of its own without the request's transaction (as
// prepareDay). Intake records source arrivals only; business preparation is
// daily or explicitly requested and never dispatched by an arrival.
import cds from "@sap/cds";
import { emit } from "../kernel/events";
import type { EventKind, EventRow, IngestKind } from "../kernel/types";
import type { Rows } from "./batch";
import { FeedError, upsertRows } from "./store";
import { isAdmin } from "../kernel/auth";

const LOG = cds.log("cockpit");

export const INGEST_KINDS: IngestKind[] = [
  "po_item",
  "goods_receipt",
  "confirmation",
  "freetext",
];

// ------------------------------------------------------------------ access

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Feed operations require admin; non-loopback requests also require
 * CDS_TIDE_FEED_REMOTE=true. Local mock authentication grants admin to the demo user.
 */
export function assertFeedAccess(req: cds.Request) {
  const user: any = req.user;
  const admin = isAdmin(user);
  if (!admin)
    throw new FeedError(403, "Only an administrator can feed or reset the day");
  const ip: string | undefined = (req as any).http?.req?.socket?.remoteAddress;
  if (ip && !LOOPBACK.test(ip) && !(cds.env as any).tide?.feed?.remote)
    throw new FeedError(
      403,
      "The feed accepts requests from this machine only",
    );
}

/** Runs `fn` detached from the request transaction, as `user`. */
function detached<T>(user: cds.User, fn: () => Promise<T>): Promise<T> {
  const ctx = new (cds.EventContext as any)({
    user,
    tenant: cds.context?.tenant,
  });
  return (cds as any)._with(ctx, fn);
}

// One feed operation at a time: events keep their order, journal IDs stay unique.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  // The previous operation's outcome is ignored; its rejection is already
  // handled by its own caller.
  const run = queue.catch(() => undefined).then(fn);
  queue = run.catch(() => undefined);
  return run;
}

// ------------------------------------------------------------------ texts

const itemText = (key: string) => {
  const [a, b] = key.split("/");
  return b ? `PO ${a} item ${b}` : key;
};
const reqText = (key: string) => {
  const [a, b] = key.split("/");
  return b ? `request ${a} item ${b}` : key;
};

function first(rows: Rows, ...entities: string[]): Record<string, any> {
  for (const e of entities) if (rows[e]?.length) return rows[e][0];
  return {};
}

/** Key of the object an ingest is about, and the sentence of its arrival. */
export function arrival(
  kind: IngestKind,
  rows: Rows,
): { objectKey: string | null; title: string } {
  if (kind === "po_item") {
    const r = first(rows, "PurchaseOrderItem");
    const key = r.PurchaseOrder
      ? `${r.PurchaseOrder}/${String(r.PurchaseOrderItem ?? "").replace(/^0+(?=\d)/, "")}`
      : null;
    return {
      objectKey: key,
      title: `New ${key ? itemText(key) : "PO item"}${r.Plant ? ` in plant ${r.Plant}` : ""}`,
    };
  }
  if (kind === "goods_receipt") {
    const r = first(rows, "MaterialDocumentItem");
    const key = r.PurchaseOrder
      ? `${r.PurchaseOrder}/${String(r.PurchaseOrderItem ?? "").replace(/^0+(?=\d)/, "")}`
      : null;
    return {
      objectKey: key,
      title: `Goods receipt for ${key ? itemText(key) : "a PO item"}${r.PostingDate ? ` on ${r.PostingDate}` : ""}`,
    };
  }
  if (kind === "confirmation") {
    const i = first(rows, "SupplierConfirmationItem");
    const l = first(rows, "SupplierConfirmationLine");
    const po =
      i.SuplrConfRefPurchaseOrder ??
      first(rows, "SupplierConfirmation").SuplrConfRefPurchaseOrder;
    const key = po
      ? `${po}/${String(i.SuplrConfRefPurchaseOrderItem ?? "").replace(/^0+(?=\d)/, "")}`
      : null;
    return {
      objectKey: key,
      title: `Confirmation for ${key ? itemText(key) : "a PO item"}${l.DeliveryDate ? `: delivery on ${l.DeliveryDate}` : ""}`,
    };
  }
  const r = first(rows, "PurchaseReqnItem");
  const key = r.PurchaseRequisition
    ? `${r.PurchaseRequisition}/${String(r.PurchaseRequisitionItem ?? "").replace(/^0+(?=\d)/, "")}`
    : null;
  return {
    objectKey: key,
    title: `Free-text ${key ? reqText(key) : "request"}${r.Plant ? ` in plant ${r.Plant}` : ""}`,
  };
}

// ------------------------------------------------------------------ ingest

export interface IngestPayload {
  at?: string;
  rows: Rows;
}

export function parsePayload(payload: unknown): IngestPayload {
  let p: any = payload;
  if (typeof payload === "string") {
    try {
      p = JSON.parse(payload);
    } catch {
      throw new FeedError(400, "payload is not valid JSON");
    }
  }
  if (!p || typeof p !== "object" || !p.rows)
    throw new FeedError(400, "payload needs {at, rows: {<entity>: [rows]}}");
  if (p.at && Number.isNaN(Date.parse(p.at)))
    throw new FeedError(400, `payload.at is not a timestamp: ${p.at}`);
  return p;
}

/**
 * Upserts the rows, refreshes the facts of the affected PO items, runs the
 * ingest hooks of `kind` in step order and emits one event per step: the
 * arrival, then every hook's events (a hook's model calls, cost units and
 * latency on its first event). Returns the emitted events.
 */
export async function ingestRows(
  user: cds.User,
  kind: IngestKind,
  p: IngestPayload,
): Promise<EventRow[]> {
  if (!INGEST_KINDS.includes(kind))
    throw new FeedError(400, `kind must be one of ${INGEST_KINDS.join(", ")}`);
  const at = p.at ? new Date(p.at).toISOString() : new Date().toISOString();
  const started = Date.now();
  const written = await upsertRows(p.rows);
  const { objectKey, title } = arrival(kind, p.rows);
  const out: EventRow[] = [];
  const put = async (e: Partial<EventRow>, fallback: Partial<EventRow> = {}) =>
    out.push(
      await emit({
        simTime: at,
        objectKey,
        ...fallback,
        ...e,
        kind: (e.kind ?? kind) as EventKind,
        title: String(e.title ?? title),
      }),
    );
  await put({
    title,
    status: "arrived",
    source: kind === "confirmation" ? "confirmation" : null,
    latencyMs: Date.now() - started,
    modelCalls: 0,
    costUnits: 0,
  });
  LOG.debug(`ingest ${kind} ${objectKey}: ${written} rows`);
  return out;
}

export function ingest(req: cds.Request): Promise<EventRow[]> {
  assertFeedAccess(req);
  const kind = String(req.data.kind ?? "") as IngestKind;
  const p = parsePayload(req.data.payload);
  return serial(() => detached(req.user, () => ingestRows(req.user, kind, p)));
}

/** Rows of changed documents (feeder entries of kind change): upsert, refresh facts; no hooks, no events. */
export async function applyChanges(req: cds.Request) {
  assertFeedAccess(req);
  const p = parsePayload(req.data.payload);
  return serial(() =>
    detached(req.user, async () => {
      const n = await upsertRows(p.rows);
      return n;
    }),
  );
}

/** Maps a FeedError to the request's error. */
export function handle<T>(
  req: cds.Request,
  fn: (req: cds.Request) => Promise<T>,
) {
  return async () => {
    try {
      return await fn(req);
    } catch (e: any) {
      if (e instanceof FeedError) return req.reject(e.status, e.message);
      throw e;
    }
  };
}
