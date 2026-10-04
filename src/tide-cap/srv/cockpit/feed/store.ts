// Database side of the feed: upsert of ingested tide.s4 rows by key with a
// journal of before-images (for resetDay), refresh of the affected ItemFact
// rows, and the restore of the journal.
import cds from "@sap/cds";
import { isDeepStrictEqual } from "node:util";
import { touchedItems, type Rows } from "./batch";

const { SELECT, UPSERT, DELETE, INSERT } = cds.ql;
const S4 = "tide.s4";
const NS = "tide.cockpit";
const JOURNAL = `${NS}.FeedJournal`;

/** Item numbers are stored without leading zeros, as the loader stores them. */
const ITEM_NUMBERS = new Set([
  "PurchaseOrderItem",
  "SalesOrderItem",
  "SuplrConfRefPurchaseOrderItem",
  "ReferenceSDDocumentItem",
  "PrecedingDocumentItem",
  "PurchasingDocumentItem",
  "SDDocumentItem",
]);
const NOT_INGESTED = new Set(["DatasetInfo"]);

export class FeedError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface EntityInfo {
  name: string;
  keys: string[];
  columns: Set<string>;
}

function entityInfo(name: string): EntityInfo {
  const def: any = (cds.model as any).definitions[`${S4}.${name}`];
  if (
    !def ||
    def.kind !== "entity" ||
    def.query ||
    def.projection ||
    NOT_INGESTED.has(name)
  )
    throw new FeedError(400, `Unknown S/4 table "${name}"`);
  const columns = new Set<string>();
  const keys: string[] = [];
  for (const [n, e] of Object.entries<any>(def.elements)) {
    if (
      e.isAssociation ||
      e.virtual ||
      e.type === "cds.Association" ||
      e.type === "cds.Composition"
    )
      continue;
    columns.add(n);
    if (e.key) keys.push(n);
  }
  return { name, keys, columns };
}

const normItem = (v: unknown) =>
  v === null || v === undefined ? v : String(v).replace(/^0+(?=\d)/, "");

/** Only modelled columns, item numbers normalised; throws when a key is missing. */
export function cleanRow(
  info: EntityInfo,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {}))
    if (info.columns.has(k)) out[k] = ITEM_NUMBERS.has(k) ? normItem(v) : v;
  // S/4 keeps unused key fields as empty strings (e.g. the special-stock keys
  // of the stock segment): empty is a value, only absent keys are refused.
  for (const k of info.keys)
    if (out[k] === null && k in (row ?? {})) out[k] = "";
  // Stock segments: absent special-stock keys mean "not special stock".
  if (/MatlStkInAcctMod$/.test(info.name))
    for (const k of info.keys) out[k] ??= "";
  const missing = info.keys.filter((k) => out[k] === undefined);
  if (missing.length)
    throw new FeedError(
      400,
      `${info.name}: key field(s) missing: ${missing.join(", ")}`,
    );
  return out;
}

/** Validates the rows (entities known, keys present) before anything is written. */
export function validate(
  rows: Rows,
): Array<{ info: EntityInfo; rows: Record<string, unknown>[] }> {
  if (!rows || typeof rows !== "object" || Array.isArray(rows))
    throw new FeedError(
      400,
      "payload.rows must be an object {<entity>: [rows]}",
    );
  return Object.entries(rows).map(([name, list]) => {
    if (!Array.isArray(list))
      throw new FeedError(400, `payload.rows.${name} must be an array`);
    const info = entityInfo(name);
    const unique = new Map<string, Record<string, unknown>>();
    for (const row of list) {
      const cleaned = cleanRow(info, row);
      const identity = JSON.stringify(info.keys.map((key) => String(cleaned[key])));
      const previous = unique.get(identity);
      if (previous && !isDeepStrictEqual(previous, cleaned))
        throw new FeedError(
          400,
          `${info.name}: conflicting duplicate source key ${identity}`,
        );
      unique.set(identity, cleaned);
    }
    return { info, rows: [...unique.values()] };
  });
}

const pick = (row: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, row[k]]));

/**
 * Upserts rows by key (one transaction): an existing row is merged with the
 * new values, a new row inserted; every write journals the before-image.
 * Returns the number of rows written.
 */
export async function upsertRows(rows: Rows): Promise<number> {
  const groups = validate(rows);
  let n = 0;
  await cds.tx(async () => {
    const top = await SELECT.one.from(JOURNAL).columns("max(ID) as ID");
    let id = Number(top?.ID ?? 0);
    const at = new Date().toISOString();
    for (const { info, rows: list } of groups) {
      const entity = `${S4}.${info.name}`;
      for (const row of list) {
        const keys = pick(row, info.keys);
        const before = await SELECT.one.from(entity).where(keys);
        await INSERT.into(JOURNAL).entries({
          ID: ++id,
          entity: info.name,
          keys: JSON.stringify(keys),
          before: before ? JSON.stringify(before) : null,
          supplied: JSON.stringify(row),
          at,
        });
        await UPSERT.into(entity).entries(before ? { ...before, ...row } : row);
        n++;
      }
    }
    if (n > 0)
      await cds.ql.UPDATE.entity(`${S4}.DatasetInfo`)
        .set({ loadId: cds.utils.uuid(), loadedAt: at })
        .where({ ID: "current" });
  });
  return n;
}

export { hasFreshFieldObservation, freshFieldObservation } from "../kernel/feed-journal";

/** Restores every journaled row to its before-image, newest first, and empties the journal. */
export async function restoreJournal(): Promise<number> {
  return cds.tx(async () => {
    const entries: any[] = await SELECT.from(JOURNAL).orderBy("ID desc");
    for (const e of entries) {
      const entity = `${S4}.${e.entity}`;
      if (e.before) await UPSERT.into(entity).entries(JSON.parse(e.before));
      else await DELETE.from(entity).where(JSON.parse(e.keys));
    }
    await DELETE.from(JOURNAL);
    if (entries.length)
      await cds.ql.UPDATE.entity(`${S4}.DatasetInfo`)
        .set({ loadId: cds.utils.uuid(), loadedAt: new Date().toISOString() })
        .where({ ID: "current" });
    return entries.length;
  });
}

export async function journalSize(): Promise<number> {
  const r = await SELECT.one.from(JOURNAL).columns("count(1) as n");
  return Number(r?.n ?? 0);
}

/**
 * Re-materializes the ItemFact rows of the PO items the rows touch (a PO
 * header touches all its items) from ItemFactSource, as prepareDay does for
 * the whole dataset. Items without a source row any more are removed.
 * Returns the refreshed item keys.
 */
export async function refreshFacts(
  rows: Rows,
): Promise<Array<{ PurchaseOrder: string; PurchaseOrderItem: string }>> {
  const { items, pos } = touchedItems(rows);
  return cds.tx(async () => {
    const wanted = new Map(
      items.map((i) => [`${i.PurchaseOrder}/${i.PurchaseOrderItem}`, i]),
    );
    if (pos.length) {
      const more: any[] = await SELECT.from(`${S4}.PurchaseOrderItem`)
        .columns("PurchaseOrder", "PurchaseOrderItem")
        .where({ PurchaseOrder: { in: pos } });
      for (const m of more)
        wanted.set(`${m.PurchaseOrder}/${m.PurchaseOrderItem}`, m);
    }
    if (!wanted.size) return [];
    const cols = Object.keys(
      (cds.model as any).definitions[`${NS}.ItemFact`].elements,
    );
    const byPo = new Map<string, Set<string>>();
    for (const i of wanted.values())
      (
        byPo.get(i.PurchaseOrder) ??
        byPo.set(i.PurchaseOrder, new Set()).get(i.PurchaseOrder)!
      ).add(i.PurchaseOrderItem);
    for (const [po, its] of byPo) {
      const fresh: any[] = await SELECT.from(`${NS}.ItemFactSource`)
        .columns(...cols)
        .where({ PurchaseOrder: po, PurchaseOrderItem: { in: [...its] } });
      const found = new Set(fresh.map((f) => String(f.PurchaseOrderItem)));
      if (fresh.length) await UPSERT.into(`${NS}.ItemFact`).entries(fresh);
      const gone = [...its].filter((i) => !found.has(i));
      if (gone.length)
        await DELETE.from(`${NS}.ItemFact`).where({
          PurchaseOrder: po,
          PurchaseOrderItem: { in: gone },
        });
    }
    return [...wanted.values()];
  });
}
