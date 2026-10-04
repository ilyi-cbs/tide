// Step 2 of prepareDay: own lead times per source (material x supplier x
// plant), received before the as-of date.
import cds from "@sap/cds";
import { NS, type Row } from "../kernel/model-calls";
import { key, type SourceKey } from "./shared";

const { SELECT } = cds.ql;

export interface Source {
  Material: string;
  Supplier: string;
  Plant: string;
  history: { po: string; lt: number; available: string }[];
}

/** Own lead times per source (or of one source), received before the as-of date, in receipt order. */
export async function histories(asOf: string, only?: SourceKey, sourceOnly = false): Promise<Map<string, Source>> {
  const q = SELECT.from(`${NS}.${sourceOnly ? "ItemFactSource" : "ItemFact"}`)
    .columns(
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Supplier",
      "Plant",
      "LeadTimeDays",
      "AvailableDate",
    )
    .where`LeadTimeDays >= 0 and AvailableDate < ${asOf} and Material != ''`
    .orderBy("AvailableDate", "PurchaseOrder", "PurchaseOrderItem");
  if (only) q.where({ Material: only.Material, Supplier: only.Supplier, Plant: only.Plant });
  const rows: Row[] = await q;
  const out = new Map<string, Source>();
  for (const r of rows) {
    const k = key(r.Material, r.Supplier, r.Plant);
    let s = out.get(k);
    if (!s) {
      s = { Material: r.Material, Supplier: r.Supplier, Plant: r.Plant, history: [] };
      out.set(k, s);
    }
    s.history.push({
      po: `${r.PurchaseOrder}/${r.PurchaseOrderItem}`,
      lt: r.LeadTimeDays,
      available: r.AvailableDate,
    });
  }
  return out;
}
