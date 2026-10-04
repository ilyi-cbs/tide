// Finding rows and detail lines of the rule lists, built from domain results;
// the Confirmation store and small CQL helpers shared by the use cases.
import cds from "@sap/cds";
import { findingID } from "../kernel/findings";
import { NS, type Row } from "../kernel/model-calls";
import type { FindingList, FindingRow } from "../kernel/types";
import {
  CHECKS,
  FIELD_WORDS,
  NEXT_PRICE,
  NEXT_REMINDER,
  NEXT_WORKLIST,
  confirmationsFromRows,
  fmtAmount,
  fmtNumber,
  plainChain,
  priceKey,
  unitPrice,
  technicalChain,
  type DuplicateGroup,
  type PriceRow,
  type PriceSlip,
  type RareCombination,
} from "./domain";
import * as store from "./store";

const { SELECT, INSERT, DELETE } = cds.ql;

export const RULE_LISTS: FindingList[] = [
  "overdue",
  "price",
  "duplicate",
  "rare",
];
const PRICE_HISTORY_LINES = 20;

type Names = store.Names;

// ------------------------------------------------------------ row builders

const title = (
  po: string,
  item: string,
  material: string | null | undefined,
  n: Names,
) =>
  `${po}/${item}${material ? ` · ${n.material.get(material) ?? material}` : ""}`.slice(
    0,
    120,
  );
const subtitle = (
  supplier: string | null | undefined,
  plant: string | null | undefined,
  n: Names,
) =>
  [
    supplier ? (n.supplier.get(supplier) ?? `Supplier ${supplier}`) : null,
    plant ? `Plant ${plant}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
const materialTitle = (material: string, n: Names) =>
  `${material}${n.material.get(material) ? ` · ${n.material.get(material)}` : ""}`.slice(
    0,
    120,
  );
/** "<code> – <name>" combined display for a code-list field; falls back to the code alone. */
const display = (
  code: string | null | undefined,
  name: string | null | undefined,
): string | null => (code ? (name ? `${code} – ${name}` : code) : null);

export function base(
  list: FindingList,
  objectKey: string,
  issue: string,
  issueTechnical: string,
  next: string,
  arrived = false,
): FindingRow {
  return {
    list,
    objectKey,
    issue: issue.slice(0, 300),
    issueTechnical: issueTechnical.slice(0, 300),
    nextStep: next,
    nextActionKind: next === NEXT_REMINDER ? "reminder" : "worklist",
    source: "rule",
    chain: plainChain(issue, next, arrived).slice(0, 1000),
    technicalChain: technicalChain(
      CHECKS[list as keyof typeof CHECKS],
      issueTechnical,
      next,
      arrived,
    ).slice(0, 1000),
    trigger: arrived ? "arrived" : "morning",
    status: "open",
  };
}

export function itemRefs(r: Row, n: Names): Partial<FindingRow> {
  return {
    PurchaseOrder: r.PurchaseOrder,
    PurchaseOrderItem: r.PurchaseOrderItem,
    Material: r.Material || null,
    Supplier: r.Supplier ?? null,
    supplierDisplay: display(r.Supplier, n.supplier.get(r.Supplier)),
    Plant: r.Plant ?? null,
    plantDisplay: display(r.Plant, n.plant.get(r.Plant)),
    PurchasingGroup: r.PurchasingGroup ?? null,
    MRPController: r.MRPController ?? null,
    itemTitle: title(r.PurchaseOrder, r.PurchaseOrderItem, r.Material, n),
    itemSubtitle: subtitle(r.Supplier, r.Plant, n),
  };
}

export function priceFinding(
  s: PriceSlip<PriceRow & Row>,
  n: Names,
  arrived = false,
): { row: FindingRow; lines: Row[] } {
  const r = s.row;
  const key = `${r.PurchaseOrder}/${r.PurchaseOrderItem}`;
  const row: FindingRow = {
    ...base("price", key, s.issue, s.issueTechnical, NEXT_PRICE, arrived),
    ...itemRefs(r, n),
    impactText:
      `${fmtAmount(s.unitPrice, r.Currency)} per unit instead of about ${fmtAmount(s.priorMedian, r.Currency)}`.slice(
        0,
        200,
      ),
    nextActionKind: "price_clarification",
    changeAvailable: true,
    priceDetail: {
      unitPrice: s.unitPrice,
      priorMedian: s.priorMedian,
      priorCount: s.nPrior,
      ratio: s.ratio,
      factor: s.factor,
      direction: s.direction,
      priceKey: priceKey(r),
      currentPrice: r.NetPriceAmount ?? null,
      priceQuantity: r.NetPriceQuantity ?? null,
      proposalPrice:
        Math.round(s.priorMedian * (Number(r.NetPriceQuantity) || 1) * 100) /
        100,
      potentialDifference:
        r.OrderQuantity == null
          ? null
          : Math.round(
              Math.abs(s.unitPrice - s.priorMedian) *
                Number(r.OrderQuantity) *
                100,
            ) / 100,
      currency: r.Currency ?? null,
    },
  };
  const id = findingID("price", key);
  const hist = s.history.slice(-PRICE_HISTORY_LINES);
  const lines: Row[] = [
    ...hist.map((h, i) => ({
      findingID: id,
      line: i + 1,
      kind: "price",
      label: `${h.PurchaseOrder}/${h.PurchaseOrderItem}`,
      text: r.Currency,
      date: h.PurchaseOrderDate,
      amount: Math.round(h.unitPrice * 10_000) / 10_000,
      isCurrent: false,
    })),
    {
      findingID: id,
      line: hist.length + 1,
      kind: "price",
      label: key,
      text: r.Currency,
      date: r.PurchaseOrderDate,
      amount: Math.round(s.unitPrice * 10_000) / 10_000,
      isCurrent: true,
    },
  ];
  return { row, lines };
}

/** Model-only price anomalies share the rule case identity and clarification workflow. */
export function modelPriceFinding(
  r: PriceRow & Row,
  assessment: Row,
  n: Names,
  arrived = false,
  history: Row[] = [],
): { row: FindingRow; lines: Row[] } {
  const key = `${r.PurchaseOrder}/${r.PurchaseOrderItem}`;
  const actual = Number(assessment.actualUnitPrice);
  const expected = Number(assessment.expectedP50);
  const deviation = Number(assessment.deviationPercent);
  const issue = `Entered unit price is outside the expected comparable-price range`;
  const detail = `unit price ${fmtNumber(actual)} against expected p10-p90 ${fmtNumber(Number(assessment.expectedP10))}-${fmtNumber(Number(assessment.expectedP90))} ${r.Currency}; deviation ${fmtNumber(deviation)}%`;
  return {
    row: {
      ...base("price", key, issue, detail, NEXT_PRICE, arrived),
      ...itemRefs(r, n),
      impactText:
        `${fmtAmount(actual, r.Currency)} per unit; expected about ${fmtAmount(expected, r.Currency)}`.slice(
          0,
          200,
        ),
      nextActionKind: "price_clarification",
      changeAvailable: true,
      source: assessment.source === "fallback" ? "fallback" : "tabpfn",
      priceDetail: {
        unitPrice: actual,
        priorMedian: Number(assessment.historicalMedian),
        priorCount: Number(assessment.historicalCount),
        ratio: expected ? actual / expected : 0,
        factor: null as any,
        direction: actual >= expected ? "higher" : "lower",
        priceKey: priceKey(r),
        currentPrice: r.NetPriceAmount ?? null,
        priceQuantity: r.NetPriceQuantity ?? null,
        proposalPrice:
          Math.round(expected * (Number(r.NetPriceQuantity) || 1) * 100) / 100,
        potentialDifference:
          r.OrderQuantity == null
            ? null
            : Math.round(
                Math.abs(actual - expected) * Number(r.OrderQuantity) * 100,
              ) / 100,
        currency: r.Currency ?? null,
        expectedP10: Number(assessment.expectedP10),
        expectedP50: expected,
        expectedP90: Number(assessment.expectedP90),
        deviationPercent: deviation,
        tailPosition: assessment.tailPosition ?? null,
        assessmentSource: assessment.source ?? null,
        assessmentRunID: assessment.run_ID ?? null,
        calibrationStatus: assessment.calibrationStatus ?? "uncalibrated",
      },
    },
    lines: [
      ...history
        .filter(
          (entry) =>
            priceKey(entry as PriceRow) === priceKey(r) &&
            entry.PurchaseOrderDate < r.PurchaseOrderDate &&
            entry.PurchaseOrder !== r.PurchaseOrder &&
            unitPrice(entry as PriceRow) !== null,
        )
        .sort((left, right) =>
          left.PurchaseOrderDate.localeCompare(right.PurchaseOrderDate),
        )
        .slice(-PRICE_HISTORY_LINES),
      r,
    ].map((entry, index) => ({
      findingID: findingID("price", key),
      line: index + 1,
      kind: "price",
      label: `${entry.PurchaseOrder}/${entry.PurchaseOrderItem}`,
      text: r.Currency,
      date: entry.PurchaseOrderDate,
      amount: unitPrice(entry as PriceRow),
      isCurrent: entry === r,
    })),
  };
}

export function duplicateFinding(
  g: DuplicateGroup,
  n: Names,
  groups: Map<string, string>,
): { row: FindingRow; lines: Row[] } {
  const first = g.members[0].Product;
  const key = `${g.ProductType || "-"}:${first}`.slice(0, 80);
  const id = findingID("duplicate", key);
  const row: FindingRow = {
    ...base("duplicate", key, g.issue, g.issueTechnical, NEXT_WORKLIST),
    Material: first,
    Plant: g.mainPlant,
    PurchasingGroup: g.mainPlant
      ? (groups.get(`${first}|${g.mainPlant}`) ?? null)
      : null,
    itemTitle: `${g.description ?? first}`.slice(0, 120),
    itemSubtitle: g.members
      .map((m) => m.Product)
      .join(", ")
      .slice(0, 200),
    impactText: `${g.activity} orders and movements in 12 months`,
    nextActionKind: "mdg_case",
    rank: g.rank,
    duplicateDetail: {
      groupKey: g.groupKey,
      activity: g.activity,
      candidateCount: g.members.length,
      materialType: g.ProductType || null,
      materialNumbers: g.members.map((m) => m.Product).join(", "),
      mainPlant: g.mainPlant,
      purchasingGroup: g.mainPlant
        ? (groups.get(`${first}|${g.mainPlant}`) ?? null)
        : null,
    },
  };
  const lines = g.members.map((m, i) => ({
    findingID: id,
    line: i + 1,
    kind: "member",
    label: m.Product,
    text: (m.ProductDescription ?? "").slice(0, 120),
    n1: m.recentPOs,
    n2: m.recentMovements,
    similarityScore: m.similarityScore,
  }));
  return { row, lines };
}

export function rareFinding(
  c: RareCombination,
  n: Names,
  groups: Map<string, string>,
): { row: FindingRow; lines: Row[] } {
  const key = `${c.Product}|${c.Plant}`;
  const id = findingID("rare", key);
  const row: FindingRow = {
    ...base("rare", key, c.issue, c.issueTechnical, NEXT_WORKLIST),
    Material: c.Product,
    Plant: c.Plant,
    PurchasingGroup: groups.get(key) ?? null,
    itemTitle: materialTitle(c.Product, n),
    itemSubtitle: `Plant ${c.Plant} · material type ${c.ProductType || "blank"}`,
    impactText: `${c.pairs.length} unusual setting${c.pairs.length > 1 ? "s" : ""} of ${c.groupSize} materials`,
    nextActionKind: "planner_review",
    rareDetail: {
      groupSize: c.groupSize,
      materialType: c.ProductType || null,
      unusualPairCount: c.pairs.length,
      firstPair: `${FIELD_WORDS[c.pairs[0].a]} + ${FIELD_WORDS[c.pairs[0].b]}`,
    },
  };
  const shown = (v: string) => (v === "" ? "blank" : v);
  const lines = c.pairs.map((p, i) => ({
    findingID: id,
    line: i + 1,
    kind: "pair",
    label: `${FIELD_WORDS[p.a]} + ${FIELD_WORDS[p.b]}`.slice(0, 80),
    text: `${shown(p.valueA)} + ${shown(p.valueB)}`.slice(0, 120),
    n1: p.countA,
    n2: p.countB,
    n3: p.countBoth,
  }));
  return { row, lines };
}

// ------------------------------------------------------------ confirmations

/** Copies the SAP confirmations (origin sap) known at asOf into Confirmation; app / feeder lines stay. */
export async function copySapConfirmations(asOf: string): Promise<number> {
  const parsed = confirmationsFromRows(
    await store.sapConfirmationRows(),
  ).filter((c) => !c.createdOn || c.createdOn < asOf);
  await DELETE.from(`${NS}.Confirmation`).where({ origin: "sap" });
  if (!parsed.length) return 0;
  const kept: Row[] = await SELECT.from(`${NS}.Confirmation`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "line",
  );
  const next = new Map<string, number>();
  for (const k of kept) {
    const key = `${k.PurchaseOrder}/${k.PurchaseOrderItem}`;
    next.set(key, Math.max(next.get(key) ?? 0, Number(k.line)));
  }
  const rows = parsed.map((c) => {
    const key = `${c.PurchaseOrder}/${c.PurchaseOrderItem}`;
    const line = (next.get(key) ?? 0) + 1;
    next.set(key, line);
    return {
      PurchaseOrder: c.PurchaseOrder,
      PurchaseOrderItem: c.PurchaseOrderItem,
      line,
      date: c.date,
      quantity: c.quantity,
      enteredBy: "SAP",
      enteredAt: c.createdOn ? `${c.createdOn}T00:00:00Z` : null,
      origin: "sap",
    };
  });
  for (let i = 0; i < rows.length; i += 500)
    await INSERT.into(`${NS}.Confirmation`).entries(rows.slice(i, i + 500));
  return rows.length;
}

export async function addConfirmation(
  po: string,
  item: string,
  date: string,
  quantity: number | null,
  origin: "app" | "feeder",
  by: string,
) {
  const top = await SELECT.one
    .from(`${NS}.Confirmation`)
    .columns("max(line) as line")
    .where({ PurchaseOrder: po, PurchaseOrderItem: item });
  const row = {
    PurchaseOrder: po,
    PurchaseOrderItem: item,
    line: Number(top?.line ?? 0) + 1,
    date,
    quantity,
    enteredBy: by.slice(0, 80),
    enteredAt: new Date().toISOString(),
    origin,
  };
  await INSERT.into(`${NS}.Confirmation`).entries(row);
  return row;
}

export async function confirmedKeys(): Promise<Set<string>> {
  const rows: Row[] = await SELECT.from(`${NS}.Confirmation`).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
  );
  return new Set(rows.map((r) => `${r.PurchaseOrder}/${r.PurchaseOrderItem}`));
}

/** CQN where of field → value (or array); `list` is a CQN token name, so object-style where({list}) misparses. */
export function eq(where: Record<string, unknown>): any[] {
  const xpr: any[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (xpr.length) xpr.push("and");
    xpr.push(
      { ref: [k] },
      ...(Array.isArray(v)
        ? ["in", { list: v.map((val) => ({ val })) }]
        : ["=", { val: v }]),
    );
  }
  return xpr;
}

export async function openFindingID(
  list: FindingList,
  po: string,
  item: string,
): Promise<string | null> {
  const f = await SELECT.one
    .from(`${NS}.Finding`)
    .columns("ID")
    .where(
      eq({ list, PurchaseOrder: po, PurchaseOrderItem: item, status: "open" }),
    );
  return f?.ID ?? null;
}

export async function writeRuleLines(lines: Row[], replaceFor?: string[]) {
  if (replaceFor) {
    if (replaceFor.length)
      await DELETE.from(`${NS}.RuleLine`).where({
        findingID: { in: replaceFor },
      });
  } else await DELETE.from(`${NS}.RuleLine`);
  for (let i = 0; i < lines.length; i += 500)
    await INSERT.into(`${NS}.RuleLine`).entries(lines.slice(i, i + 500));
}
