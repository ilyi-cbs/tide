import cds from "@sap/cds";
import { GRID, median } from "../logic";
import { FEATURES, FEED, NS, type Row } from "./model-calls";

type SourceKey = { Material: string; Supplier: string; Plant: string };
const sourceKey = (source: SourceKey) =>
  `${source.Material}|${source.Supplier}|${source.Plant}`;
const { SELECT } = cds.ql;

export async function sourceFeedRows(): Promise<Row[]> {
  const rows: Row[] = await SELECT.from(`${NS}.ItemFactSource`);
  return rows.map((row) => ({
    ...row,
    id: `${row.PurchaseOrder}/${row.PurchaseOrderItem}`,
  }));
}

export async function representativeItems(
  sources: SourceKey[],
  asOf: string,
  liveSource = false,
): Promise<Map<string, string>> {
  const wanted = new Set(sources.map(sourceKey));
  const one = sources.length === 1 ? sources[0] : null;
  const rows: Row[] = await SELECT.from(`${NS}.${liveSource ? "ItemFactSource" : "ItemFact"}`)
    .columns(
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Supplier",
      "Plant",
      "RequestedGapDays",
      "PurchaseOrderDate",
    )
    .where(
      one
        ? { Material: one.Material, Supplier: one.Supplier, Plant: one.Plant }
        : { Material: { "!=": "" } },
    ).and`PurchaseOrderDate < ${asOf}`.orderBy(
    "PurchaseOrderDate",
    "PurchaseOrder",
    "PurchaseOrderItem",
  );
  const bySource = new Map<string, Row[]>();
  for (const row of rows) {
    const key = sourceKey(row as SourceKey);
    if (wanted.has(key))
      (bySource.get(key) ?? bySource.set(key, []).get(key)!).push(row);
  }
  const out = new Map<string, string>();
  for (const [key, list] of bySource) {
    const gaps = list
      .map((row) => row.RequestedGapDays)
      .filter((gap) => gap !== null && gap !== undefined);
    const mid = gaps.length ? median(gaps) : 0;
    let best = list[list.length - 1];
    let bestDist = Infinity;
    for (const row of list) {
      const dist = Math.abs((row.RequestedGapDays ?? mid) - mid);
      if (dist <= bestDist) [best, bestDist] = [row, dist];
    }
    out.set(key, `${best.PurchaseOrder}/${best.PurchaseOrderItem}`);
  }
  return out;
}

export function rangeSpec(plant: string, keys: string[], asOf: string) {
  return {
    feed: FEED,
    target: "LeadTimeDays",
    features: FEATURES,
    task: "regression",
    train: {
      filter: [
        { col: "Plant", op: "=", value: plant },
        { col: "LeadTimeDays", op: ">=", value: "0" },
        { col: "AvailableDate", op: "<", value: asOf },
        { col: "PurchaseOrderDate", op: "<", value: asOf },
      ],
    },
    predict: { keys },
    output: { type: "quantiles", levels: GRID },
  };
}
