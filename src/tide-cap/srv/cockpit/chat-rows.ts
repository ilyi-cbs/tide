// Buyer-word views of cockpit rows and actions for the chat tools (./mcp.ts):
// never expert fields.
import cds from "@sap/cds";
import { sourceText } from "./kernel/case-text";
import { caseHash } from "./kernel/case-links";
import { NS, type Row } from "./kernel/model-calls";
import type { FindingList } from "./kernel/types";
import { MAX_MODEL_ROWS } from "./chat-view";
import { scopeOf, type Scope } from "./kernel/auth";

const { SELECT } = cds.ql;

/** Rows a list tool returns; the model sees the same number (chat-view.ts). */
export const MAX_ROWS = MAX_MODEL_ROWS;

export const LIST_TEXT: Record<FindingList, string> = {
  at_risk: "May be late",
  overdue: "Overdue",
  price: "Price",
  pdt: "Planned times",
  mm_pdt: "Material master",
  freetext: "Free text",
  duplicate: "Duplicates",
  rare: "Rare settings",
};

/** What each list means, in buyer words (get_today). */
export const LIST_MEANING: Record<FindingList, string> = {
  at_risk: "Open order items that may arrive after the requested date",
  overdue: "Open order items whose requested date has passed without the goods",
  price: "Order items whose price is far from what was paid before",
  pdt: "Planned delivery times of a supplier that do not match the real deliveries",
  mm_pdt:
    "Planned delivery times in the material master that do not match its suppliers",
  freetext:
    "Purchase requisitions in free text that need a material group and a purchasing group",
  duplicate: "Materials that look like duplicates of each other",
  rare: "Materials with settings that are rare among similar materials",
};

export const links = {
  finding: (id: string) => caseHash(id) || "#DeliveryRisks",
  action: (id: string) => `#/Actions(${id})`,
};

/** Trusted caller grants; absent scalar dimensions do not confer access. */
export async function buyerScope(user: cds.User): Promise<Scope> {
  return scopeOf(user);
}

export function publicAction(a: Row, items: Row[] = []): Row {
  return {
    ID: a.ID,
    caseID: a.caseID ?? null,
    kind: a.kind,
    status: a.status,
    objectKey: a.objectKey,
    title: a.title,
    summary: a.summary,
    preparedVia: a.preparedVia,
    findingID: a.findingID ?? null,
    createdAt: a.createdAt,
    items: items.map((i) => ({
      line: i.line,
      objectKey: i.objectKey,
      field: i.field,
      oldValue: i.oldValue,
      newValue: i.newValue,
      text: i.text,
    })),
    link: links.action(a.ID),
    where: "Approvals",
  };
}

export async function customersOf(
  PurchaseOrder: string,
  PurchaseOrderItem: string,
): Promise<string[]> {
  const rows: Row[] = await SELECT.from(`${NS}.CustomerImpact`)
    .columns("Customer", "CustomerName")
    .where({ PurchaseOrder, PurchaseOrderItem });
  return [
    ...new Set(rows.map((r) => r.CustomerName || r.Customer).filter(Boolean)),
  ].sort();
}

/** Plain words of a chain: model names and expert terms replaced (P-9). */
export function plainWords(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/tabpfn/gi, "AI estimate")
    .replace(/\bp(10|50|80|90)\b/gi, "range")
    .replace(
      /\b(quantiles?|confidence|safety time|context rows?|AUC)\b[^,;→.]*/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Sources of an mm_pdt row in buyer words. */
export function mmSources(f: Row): Row[] {
  return (f.mmPdtDetail?.sources ?? []).map((s: Row) => ({
    Supplier: s.supplier,
    SupplierName: s.supplierName ?? null,
    orders: s.orders12m ?? null,
    orderShare: s.orderShare ?? null,
    nOwn: s.ownDeliveries ?? null,
    typicalDays: s.typicalDays ?? null,
    infoRecordDays: s.infoRecordDays ?? null,
    source: s.source ?? null,
    sourceText: s.sourceText ?? sourceText(s.source),
    link: s.pdtFindingID ? links.finding(s.pdtFindingID) : null,
  }));
}
