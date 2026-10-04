// Free-text items of the loaded dataset at the as-of date (P-0, P-14).
//
// A free-text item is a requisition item without material. Its codes are the
// buyer's final codes from the purchase order it was converted into before
// the as-of date (material group of the PO item, purchasing group and
// supplier of the PO header); an item not converted before the as-of date is
// open and has no codes. The requisition's own (requester) codes are never
// used: the model proposes what the buyer would set.
//
// Demo seed (cds.env.tide.freetext.demoSeed, default 30, 0 = off): tops up; when the
// dataset has no open free-text request at the as-of date (tide-small: every
// free-text item already has its PO), the morning step builds a deterministic
// demo inbox from the youngest N labelled items (PurReqCreationDate, then
// key): they are treated as arrived requests, stored open with their codes
// hidden (held out: never context for themselves or each other), and marked
// `demo` (FreetextItem.demo, Finding.expert.demo). Their context is the older
// labelled items only (created on or before the oldest demo item), so the
// proposals stay as-of-consistent. The request text is the buyer's words,
// unchanged. Routing to buyers applies as for real open items.
import cds from "@sap/cds";
import { NS, type Row } from "../kernel/model-calls";
import {
  BLANK_CATEGORY,
  itemKey,
  type FreetextItem,
  route,
  routingTable,
} from "./domain/logic";

const { SELECT, INSERT, DELETE, UPSERT } = cds.ql;
const S4 = "tide.s4";
export const ITEM = `${NS}.FreetextItem`;
const CHUNK = 500;
/**
 * Always a root transaction of its own: model runs read the feed from another
 * connection, and SQLite has one; a request transaction must not hold it
 * while a handler waits for a run.
 */
const inTx = <T>(fn: () => Promise<T>) => cds.tx(fn) as Promise<T>;

export interface StoredItem extends FreetextItem {
  id: string;
  isOpen: boolean;
  isQuery?: boolean;
  DeliveryDate?: string | null;
  routedBuyer?: string | null;
  routedGroup?: string | null;
  demo?: boolean;
  RequisitionerName?: string | null;
  CreatedByUser?: string | null;
  RequestedQuantity?: number | null;
  BaseUnit?: string | null;
  sourcePurchasingGroup?: string | null;
  sourceMaterialGroup?: string | null;
  sourceSupplier?: string | null;
  sourceMaterial?: string | null;
  sourcePurchasingInfoRecord?: string | null;
  FixedSupplier?: string | null;
  SourceOfSupplyIsAssigned?: boolean | null;
  CompanyCode?: string | null;
  PurchasingDocumentItemCategory?: string | null;
  AccountAssignmentCategory?: string | null;
  PurchaseRequisitionPrice?: number | null;
  PurReqnPriceQuantity?: number | null;
  ItemNetAmount?: number | null;
  PurReqnItemCurrency?: string | null;
  StorageLocation?: string | null;
  Material?: string | null;
  PurchasingInfoRecord?: string | null;
  OutlineAgreement?: string | null;
  OutlineAgreementItem?: string | null;
  TaxCode?: string | null;
  GoodsReceiptIsExpected?: boolean | null;
  InvoiceIsGoodsReceiptBased?: boolean | null;
  IsEvaluatedRcptSettlmtAllowed?: boolean | null;
  ServicePerformer?: string | null;
  PerformancePeriodStartDate?: string | null;
  PerformancePeriodEndDate?: string | null;
  ExpectedOverallLimitAmount?: number | null;
  OverallLimitAmount?: number | null;
  itemLongText?: string | null;
  headerNote?: string | null;
  PurchaseRequisitionType?: string | null;
  PurReqnDescription?: string | null;
  deliveryAddress?: Row | null;
  IsDeleted?: boolean | null;
  IsClosed?: boolean | null;
  ProcessingStatus?: string | null;
  PurReqnReleaseStatus?: string | null;
  PurchasingDocument?: string | null;
  PurchasingDocumentItem?: string | null;
  accountAssignments?: Row[];
  RequestedLeadTimeDays?: number | null;
  sourceAccountAssignmentCategory?: string | null;
  sourceItemCategory?: string | null;
  accountingContext?: string | null;
}

export function requestFeatures(item: StoredItem) {
  const leadTime =
    item.DeliveryDate && item.date
      ? (Date.parse(item.DeliveryDate) - Date.parse(item.date)) / 86_400_000
      : NaN;
  return {
    RequestedQuantity: item.RequestedQuantity ?? null,
    BaseUnit: item.BaseUnit ?? null,
    CompanyCode: item.CompanyCode ?? null,
    PurchaseRequisitionPrice: item.PurchaseRequisitionPrice ?? null,
    PurReqnPriceQuantity: item.PurReqnPriceQuantity ?? null,
    PurReqnItemCurrency: item.PurReqnItemCurrency ?? null,
    RequestedLeadTimeDays:
      item.RequestedLeadTimeDays ??
      (Number.isFinite(leadTime) ? leadTime : null),
    StorageLocation: item.StorageLocation ?? null,
    itemLongText: item.itemLongText ?? null,
    headerNote: item.headerNote ?? null,
    sourceMaterialGroup: item.sourceMaterialGroup ?? null,
    sourcePurchasingGroup: item.sourcePurchasingGroup ?? null,
    sourceSupplier: item.sourceSupplier ?? null,
    sourceAccountAssignmentCategory:
      item.sourceAccountAssignmentCategory ?? null,
    sourceItemCategory: item.sourceItemCategory ?? null,
    accountingContext:
      item.accountingContext ??
      (item.accountAssignments?.length
        ? JSON.stringify(
            item.accountAssignments.map((row) => ({
              GLAccount: row.GLAccount ?? null,
              CostCenter: row.CostCenter ?? null,
              DistributionPercent: row.DistributionPercent ?? null,
              WBSElement: row.WBSElement ?? null,
              MainAsset: row.MainAsset ?? null,
              SalesOrder: row.SalesOrder ?? null,
            })),
          )
        : null),
  };
}

const blank = (v: unknown) => v === null || v === undefined || v === "";
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const noZeros = (v: unknown) => String(v ?? "").replace(/^0+(?=.)/, "");

/** True for a requisition item without material (free text). */
export function isFreeText(r: Row): boolean {
  return blank(r.Material) && !r.IsDeleted;
}

/** True when the loaded schema has the entity (requisitions may be absent). */
export const hasEntity = (entity: string) =>
  !!(cds.model as any)?.definitions?.[entity];

async function all(
  entity: string,
  columns: string[],
  where?: object,
): Promise<Row[]> {
  if (!hasEntity(entity)) return [];
  const q = SELECT.from(entity).columns(...columns);
  return where ? q.where(where) : q;
}

/**
 * Builds the free-text items from tide.s4 at `asOf`: requisitions created
 * before it; labelled when their PO is dated before it, open otherwise.
 * `only` restricts to some requisition items (ingest hook).
 */
export async function buildItems(
  asOf: string,
  only?: { PurchaseRequisition: string; PurchaseRequisitionItem: string }[],
): Promise<StoredItem[]> {
  const cols = [
    "PurchaseRequisition",
    "PurchaseRequisitionItem",
    "PurchaseRequisitionItemText",
    "Material",
    "Plant",
    "PurchasingOrganization",
    "PurReqCreationDate",
    "DeliveryDate",
    "PurchasingDocument",
    "PurchasingDocumentItem",
    "IsDeleted",
    "IsClosed",
    "ProcessingStatus",
    "PurReqnReleaseStatus",
    "RequisitionerName",
    "CreatedByUser",
    "RequestedQuantity",
    "BaseUnit",
    "PurchasingGroup",
    "MaterialGroup",
    "Supplier",
    "FixedSupplier",
    "SourceOfSupplyIsAssigned",
    "CompanyCode",
    "PurchasingDocumentItemCategory",
    "AccountAssignmentCategory",
    "PurchaseRequisitionPrice",
    "PurReqnItemCurrency",
    "PurReqnPriceQuantity",
    "ItemNetAmount",
    "StorageLocation",
    "PurchasingInfoRecord",
    "OutlineAgreement",
    "OutlineAgreementItem",
    "TaxCode",
    "GoodsReceiptIsExpected",
    "InvoiceIsGoodsReceiptBased",
    "IsEvaluatedRcptSettlmtAllowed",
    "ServicePerformer",
    "PerformancePeriodStartDate",
    "PerformancePeriodEndDate",
    "ExpectedOverallLimitAmount",
    "OverallLimitAmount",
  ];
  let reqs: Row[];
  if (only?.length) {
    reqs = [];
    for (const k of only)
      reqs.push(...(await all(`${S4}.PurchaseReqnItem`, cols, k)));
  } else reqs = await all(`${S4}.PurchaseReqnItem`, cols);
  reqs = reqs.filter(
    (r) =>
      isFreeText(r) &&
      day(r.PurReqCreationDate) !== null &&
      day(r.PurReqCreationDate)! < asOf,
  );
  if (!reqs.length) return [];

  const assignments = new Map<string, Row[]>();
  const itemTexts = new Map<string, string>();
  const addresses = new Map<string, Row>();
  const requisitionHeaders = new Map<string, Row>();
  const headerNotes = new Map<string, string>();
  for (let i = 0; i < reqs.length; i += CHUNK) {
    const ids = [
      ...new Set(reqs.slice(i, i + CHUNK).map((r) => r.PurchaseRequisition)),
    ];
    for (const a of await all(
      `${S4}.PurchaseReqnAcctAssgmt`,
      [
        "PurchaseRequisition",
        "PurchaseRequisitionItem",
        "PurchaseReqnAcctAssgmtNumber",
        "CostCenter",
        "GLAccount",
        "SalesOrder",
        "SalesOrderItem",
        "MasterFixedAsset",
        "FixedAsset",
        "OrderID",
        "WBSElement",
        "Quantity",
        "DistributionPercent",
        "BaseUnit",
        "PurReqnItemCurrency",
        "PurReqnNetAmount",
        "IsDeleted",
      ],
      { PurchaseRequisition: { in: ids } },
    )) {
      const k = itemKey(a as StoredItem);
      assignments.set(k, [...(assignments.get(k) ?? []), a]);
    }
    for (const t of await all(
      `${S4}.PurchaseReqnItemText`,
      ["PurchaseRequisition", "PurchaseRequisitionItem", "Text"],
      { PurchaseRequisition: { in: ids } },
    )) {
      const key = itemKey(t as StoredItem);
      itemTexts.set(
        key,
        [itemTexts.get(key), t.Text].filter(Boolean).join("\n\n"),
      );
    }
    for (const address of await all(
      `${S4}.PurchaseReqnDelivAddress`,
      [
        "PurchaseRequisition",
        "PurchaseRequisitionItem",
        "Name",
        "Street",
        "HouseNumber",
        "City",
        "PostalCode",
        "Country",
        "UnloadingPoint",
      ],
      { PurchaseRequisition: { in: ids } },
    ))
      addresses.set(itemKey(address as StoredItem), address);
    for (const header of await all(
      `${S4}.PurchaseReqn`,
      ["PurchaseRequisition", "PurchaseRequisitionType", "PurReqnDescription"],
      { PurchaseRequisition: { in: ids } },
    ))
      requisitionHeaders.set(header.PurchaseRequisition, header);
    for (const note of await all(
      `${S4}.PurchaseReqnText`,
      ["PurchaseRequisition", "Text"],
      { PurchaseRequisition: { in: ids } },
    ))
      headerNotes.set(
        note.PurchaseRequisition,
        [headerNotes.get(note.PurchaseRequisition), note.Text]
          .filter(Boolean)
          .join("\n\n"),
      );
  }

  const poIds = [
    ...new Set(reqs.map((r) => r.PurchasingDocument).filter((v) => !blank(v))),
  ];
  const headers = new Map<string, Row>();
  const items = new Map<string, Row>();
  for (let i = 0; i < poIds.length; i += CHUNK) {
    const ids = poIds.slice(i, i + CHUNK);
    for (const h of await SELECT.from(`${S4}.PurchaseOrder`)
      .columns(
        "PurchaseOrder",
        "PurchaseOrderType",
        "PurchaseOrderDate",
        "PurchasingGroup",
        "Supplier",
      )
      .where({ PurchaseOrder: { in: ids } }))
      headers.set(h.PurchaseOrder, h);
    for (const it of await SELECT.from(`${S4}.PurchaseOrderItem`)
      .columns(
        "PurchaseOrder",
        "PurchaseOrderItem",
        "MaterialGroup",
        "PurchaseOrderItemCategory",
        "AccountAssignmentCategory",
        "Material",
        "PurchasingInfoRecord",
      )
      .where({ PurchaseOrder: { in: ids } }))
      items.set(`${it.PurchaseOrder}/${noZeros(it.PurchaseOrderItem)}`, it);
  }
  // PO type of an open item: the most frequent one of the converted free-text items.
  const typeCount = new Map<string, number>();
  for (const h of headers.values())
    if (h.PurchaseOrderType)
      typeCount.set(
        h.PurchaseOrderType,
        (typeCount.get(h.PurchaseOrderType) ?? 0) + 1,
      );
  const usualType =
    [...typeCount].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0]?.[0] ?? null;

  return reqs.map((r) => {
    const h = headers.get(r.PurchasingDocument);
    const known =
      !!h &&
      day(h.PurchaseOrderDate) !== null &&
      day(h.PurchaseOrderDate)! < asOf;
    const poi = known
      ? items.get(
          `${r.PurchasingDocument}/${noZeros(r.PurchasingDocumentItem)}`,
        )
      : undefined;
    const base = {
      PurchaseRequisition: r.PurchaseRequisition,
      PurchaseRequisitionItem: r.PurchaseRequisitionItem,
      text: String(r.PurchaseRequisitionItemText ?? ""),
      itemLongText: itemTexts.get(itemKey(r as StoredItem)) ?? null,
      headerNote: headerNotes.get(r.PurchaseRequisition) ?? null,
      PurchaseRequisitionType:
        requisitionHeaders.get(r.PurchaseRequisition)
          ?.PurchaseRequisitionType ?? null,
      PurReqnDescription:
        requisitionHeaders.get(r.PurchaseRequisition)?.PurReqnDescription ??
        null,
      Plant: r.Plant ?? null,
      PurchasingOrganization: r.PurchasingOrganization ?? null,
      date: day(r.PurReqCreationDate)!,
      labelDate: known ? day(h!.PurchaseOrderDate) : null,
      DeliveryDate: day(r.DeliveryDate),
      RequisitionerName: r.RequisitionerName ?? null,
      CreatedByUser: r.CreatedByUser ?? null,
      RequestedQuantity: r.RequestedQuantity ?? null,
      BaseUnit: r.BaseUnit ?? null,
      sourcePurchasingGroup: r.PurchasingGroup ?? null,
      sourceMaterialGroup: r.MaterialGroup ?? null,
      sourceSupplier: r.Supplier ?? null,
      sourceMaterial: r.Material ?? null,
      sourcePurchasingInfoRecord: r.PurchasingInfoRecord ?? null,
      sourceAccountAssignmentCategory: r.AccountAssignmentCategory ?? null,
      sourceItemCategory: r.PurchasingDocumentItemCategory ?? null,
      FixedSupplier: r.FixedSupplier ?? null,
      SourceOfSupplyIsAssigned: r.SourceOfSupplyIsAssigned ?? null,
      CompanyCode: r.CompanyCode ?? null,
      PurchasingDocumentItemCategory: r.PurchasingDocumentItemCategory ?? null,
      AccountAssignmentCategory: r.AccountAssignmentCategory ?? null,
      PurchaseRequisitionPrice: r.PurchaseRequisitionPrice ?? null,
      PurReqnPriceQuantity: r.PurReqnPriceQuantity ?? null,
      ItemNetAmount: r.ItemNetAmount ?? null,
      PurReqnItemCurrency: r.PurReqnItemCurrency ?? null,
      StorageLocation: r.StorageLocation ?? null,
      Material: r.Material ?? null,
      PurchasingInfoRecord: r.PurchasingInfoRecord ?? null,
      OutlineAgreement: r.OutlineAgreement ?? null,
      OutlineAgreementItem: r.OutlineAgreementItem ?? null,
      TaxCode: r.TaxCode ?? null,
      GoodsReceiptIsExpected: r.GoodsReceiptIsExpected ?? null,
      InvoiceIsGoodsReceiptBased: r.InvoiceIsGoodsReceiptBased ?? null,
      IsEvaluatedRcptSettlmtAllowed: r.IsEvaluatedRcptSettlmtAllowed ?? null,
      ServicePerformer: r.ServicePerformer ?? null,
      PerformancePeriodStartDate: day(r.PerformancePeriodStartDate),
      PerformancePeriodEndDate: day(r.PerformancePeriodEndDate),
      ExpectedOverallLimitAmount: r.ExpectedOverallLimitAmount ?? null,
      OverallLimitAmount: r.OverallLimitAmount ?? null,
      deliveryAddress: addresses.get(itemKey(r as StoredItem)) ?? null,
      IsDeleted: !!r.IsDeleted,
      IsClosed: !!r.IsClosed,
      ProcessingStatus: r.ProcessingStatus ?? null,
      PurReqnReleaseStatus: r.PurReqnReleaseStatus ?? null,
      PurchasingDocument: r.PurchasingDocument ?? null,
      PurchasingDocumentItem: r.PurchasingDocumentItem ?? null,
      accountAssignments: assignments.get(itemKey(r as StoredItem)) ?? [],
    };
    return {
      id: itemKey(base),
      ...base,
      PurchaseOrderType: known ? (h!.PurchaseOrderType ?? null) : usualType,
      MaterialGroup: known ? (poi?.MaterialGroup ?? null) : null,
      PurchasingGroup: known ? (h!.PurchasingGroup ?? null) : null,
      Supplier: known ? (h!.Supplier ?? null) : null,
      Material: known ? (poi?.Material ?? null) : null,
      PurchasingInfoRecord: known ? (poi?.PurchasingInfoRecord ?? null) : null,
      AccountAssignmentCategory: poi
        ? poi.AccountAssignmentCategory || BLANK_CATEGORY
        : null,
      PurchasingDocumentItemCategory: poi
        ? poi.PurchaseOrderItemCategory || BLANK_CATEGORY
        : null,
      isOpen: !known && !r.IsClosed,
    };
  });
}

/** Demo seed size (0 = off). */
export function demoSeedSize(): number {
  const v = Number((cds.env as any).tide?.freetext?.demoSeed ?? 12);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Demo inbox (header comment): with fewer than `n` open items, the youngest
 * labelled items top the inbox up to `n` open demo requests with hidden codes;
 * the other labelled items newer than the oldest demo item are dropped from
 * the context. Unchanged when `n` open items exist or `n` is 0.
 */
export function seedDemo(
  items: StoredItem[],
  n = demoSeedSize(),
): StoredItem[] {
  const missing = n - items.filter((i) => i.isOpen).length;
  if (!n || missing <= 0) return items;
  const labelled = labelledOf(items);
  const picked = [...labelled]
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : b.id.localeCompare(a.id),
    )
    .slice(0, missing);
  if (!picked.length) return items;
  const ids = new Set(picked.map((i) => i.id));
  const cutoff = picked.reduce(
    (m, i) => (i.date < m ? i.date : m),
    picked[0].date,
  );
  return items
    .filter((i) => ids.has(i.id) || i.isOpen || i.date <= cutoff)
    .map((i) =>
      ids.has(i.id)
        ? {
            ...i,
            isOpen: true,
            demo: true,
            MaterialGroup: null,
            PurchasingGroup: null,
            Supplier: null,
            Material: null,
            PurchasingInfoRecord: null,
            AccountAssignmentCategory: null,
            PurchasingDocumentItemCategory: null,
          }
        : i,
    );
}

/** Routes the open items to buyers (display only); without buyers every open item is shown. */
export async function applyRouting(items: StoredItem[], preparedBuyers?: Row[]): Promise<StoredItem[]> {
  const buyers: Row[] = (
    preparedBuyers ?? await SELECT.from(`${NS}.Buyer`).columns(
      "userId",
      "PurchasingGroup",
      "Plant",
    )
  ).filter((b: Row) => !blank(b.PurchasingGroup));
  if (!buyers.length)
    return items.map((i) => ({ ...i, routedBuyer: null, routedGroup: null }));
  const table = routingTable(items, buyers as any);
  const routed = route(
    items.filter((i) => i.isOpen),
    table,
  );
  return items.map((i) => {
    const u = routed.get(i.id) ?? null;
    return {
      ...i,
      routedBuyer: u?.userId ?? null,
      routedGroup: u?.PurchasingGroup ?? null,
    };
  });
}

/** Only routed open items are shown when buyers exist (P-14 routing). */
export async function shownOpen(items: StoredItem[], preparedBuyers?: Row[]): Promise<StoredItem[]> {
  const { n } = preparedBuyers
    ? { n: preparedBuyers.filter((buyer) => !blank(buyer.PurchasingGroup)).length }
    : (await SELECT.one.from(`${NS}.Buyer`).columns("count(1) as n")
      .where`PurchasingGroup is not null and PurchasingGroup != ''`) ?? { n: 0 };
  const open = items.filter((i) => i.isOpen);
  return Number(n) > 0 ? open.filter((i) => i.routedBuyer) : open;
}

function record(i: StoredItem): Row {
  return {
    id: i.id,
    PurchaseRequisition: i.PurchaseRequisition,
    PurchaseRequisitionItem: i.PurchaseRequisitionItem,
    text: i.text.slice(0, 255),
    Plant: i.Plant,
    PurchasingOrganization: i.PurchasingOrganization,
    PurchaseOrderType: i.PurchaseOrderType,
    date: i.date,
    labelDate: i.labelDate ?? null,
    DeliveryDate: i.DeliveryDate ?? null,
    MaterialGroup: i.MaterialGroup ?? null,
    PurchasingGroup: i.PurchasingGroup ?? null,
    Supplier: i.Supplier ?? null,
    Material: i.Material ?? null,
    PurchasingInfoRecord: i.PurchasingInfoRecord ?? null,
    sourceMaterial:
      i.sourceMaterial !== undefined
        ? i.sourceMaterial
        : i.isOpen
          ? (i.Material ?? null)
          : null,
    sourcePurchasingInfoRecord:
      i.sourcePurchasingInfoRecord !== undefined
        ? i.sourcePurchasingInfoRecord
        : i.isOpen
          ? (i.PurchasingInfoRecord ?? null)
          : null,
    ...requestFeatures(i),
    AccountAssignmentCategory: i.AccountAssignmentCategory ?? null,
    PurchasingDocumentItemCategory: i.PurchasingDocumentItemCategory ?? null,
    isOpen: i.isOpen,
    isQuery: !!i.isQuery,
    routedBuyer: i.routedBuyer ?? null,
    routedGroup: i.routedGroup ?? null,
    demo: !!i.demo,
  };
}

/** Replaces all stored items (the model feed reads them). */
export async function writeItems(
  items: StoredItem[],
  transaction: "own" | "current" = "own",
) {
  const write = async () => {
    await DELETE.from(ITEM).where({ isQuery: false });
    const rows = items.map(record);
    for (let i = 0; i < rows.length; i += CHUNK)
      await INSERT.into(ITEM).entries(rows.slice(i, i + CHUNK));
  };
  if (transaction === "current") await write();
  else await inTx(write);
}

export async function upsertItems(items: StoredItem[]) {
  if (items.length)
    await inTx(async () => UPSERT.into(ITEM).entries(items.map(record)));
}

export async function deleteItems(ids: string[]) {
  if (ids.length)
    await inTx(async () => DELETE.from(ITEM).where({ id: { in: ids } }));
}

/** Stored items (without query rows). */
export async function readItems(): Promise<StoredItem[]> {
  const rows: Row[] = await inTx(async () =>
    SELECT.from(ITEM).where({ isQuery: false }),
  );
  return rows.map(
    (r) =>
      ({
        ...r,
        date: day(r.date)!,
        DeliveryDate: day(r.DeliveryDate),
        isOpen: !!r.isOpen,
        demo: !!r.demo,
      }) as StoredItem,
  );
}

export const labelledOf = (items: StoredItem[]) =>
  items.filter((i) => !i.isOpen && !i.isQuery);
