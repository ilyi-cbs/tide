// Feed hooks of deliveries at risk (P-1 single item, P-10): a new PO item gets
// its verdict (at most one range call); a goods receipt closes the item's
// row and re-estimates the open non-rule lines of the same key.
import cds from "@sap/cds";
import { addDays } from "../kernel/calendar";
import { findingID } from "../kernel/findings";
import { upsertDetectorCase } from "../kernel/detector-writers";
import { inTx, type Meter, type Row } from "../kernel/model-calls";
import type {
  HookResult,
  IngestEvent,
  Source,
  StepContext,
} from "../kernel/types";
import {
  gapDays,
  lateRates,
  parseGrid,
  pdtFlag,
  rateFor,
  ruleFires,
  sourceFor,
  verdictForItem as verdict,
  type Grid,
  type ItemVerdict,
} from "./domain/rules";
import { findingRow } from "./finding";
import {
  CTX_PLANT,
  FACT_LIVE,
  FACT,
  GRID_ENTITY,
  histories,
  iso,
  itemKey,
  lineGridRow,
  modelGrids,
  names,
  numOrNull,
  rateRows,
  skey,
  type GridTrigger,
  type ModelGrid,
} from "./grids";
import { reconcileDeliveryProblem } from "../kernel/problem-reconciliation";

const { SELECT, UPSERT } = cds.ql;
const LOG = cds.log("cockpit.atrisk");

interface Range extends ModelGrid {
  contextLevel: string;
  modelCalls: number;
}

/**
 * Grid of one key: own history (≥ 20, no call), else the leadTimeRange
 * operation of the service (feature leadtimes, at most one call; never by
 * import). No grid (null) when the key has no plant, the service answers
 * without levels (source rule / none) or fails (no dataset 409, not
 * implemented 501, inference failed): the verdict then uses the rule.
 */
async function rangeFor(
  item: Row,
  asOf: string,
  meter: Meter,
): Promise<Range | null> {
  if (!item.Plant) return null;
  const before = meter.runs.length;
  const model = await modelGrids(
    new Map([[item.Plant, [item]]]),
    asOf,
    false,
    meter,
  );
  const result = model.get(itemKey(item));
  if (!result) return null;
  return {
    ...result,
    contextLevel: CTX_PLANT,
    modelCalls: meter.runs.length - before,
  };
}

async function ownHistory(item: Row, asOf: string): Promise<number[]> {
  if (!item.Material) return [];
  const only = {
    Material: item.Material,
    Supplier: item.Supplier,
    Plant: item.Plant,
  };
  return (
    (await inTx(() => histories(asOf, FACT_LIVE, only))).get(
      skey(item.Material, item.Supplier, item.Plant),
    ) ?? []
  );
}

export interface ItemCheck {
  item: Row;
  verdict: ItemVerdict;
  gap: number | null;
  plannedDays: number | null;
  nOwn: number;
  range: Range | null;
  history: number[];
}

/**
 * Single-item verdict for one PO item at `asOf` (P-1): live facts, own lead
 * times, the rule's late rate, and one range call only when the planned
 * time is not usable and the own history is short.
 */
export async function verdictForItem(
  po: string,
  poItem: string,
  asOf: string,
  meter: Meter = {
    user: cds.context?.user ?? new cds.User("anonymous"),
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  },
): Promise<ItemCheck | null> {
  const item: Row | undefined = await inTx(async () =>
    SELECT.one
      .from(FACT_LIVE)
      .where({ PurchaseOrder: po, PurchaseOrderItem: poItem }),
  );
  if (!item) return null;
  const req = iso(item.RequestedDate);
  const pod = iso(item.PurchaseOrderDate);
  const gap = req && pod ? gapDays(pod, req) : null;
  const plannedDays = numOrNull(item.PlannedDays);
  const hist = await ownHistory(item, asOf);
  const range = item.Material ? await rangeFor(item, asOf, meter) : null;
  const source = sourceFor(plannedDays, hist.length, range?.source ?? null);
  let rate: number | null = null;
  if (source === "rule" && gap !== null) {
    const rates = lateRates(await inTx(() => rateRows(asOf, FACT_LIVE)), asOf);
    rate = rateFor(
      rates,
      ruleFires(gap, plannedDays as number) ? "fires" : "does_not_fire",
      item.Plant,
    );
  }
  const v = verdict({
    gap,
    plannedDays,
    grid: range?.grid ?? null,
    nOwn: hist.length,
    history: hist,
    rate,
    gridSource: range?.source ?? null,
  });
  return {
    item,
    verdict: v,
    gap,
    plannedDays,
    nOwn: hist.length,
    range,
    history: hist,
  };
}

function keysOf(
  ev: IngestEvent,
): { PurchaseOrder: string; PurchaseOrderItem: string }[] {
  const seen = new Map<
    string,
    { PurchaseOrder: string; PurchaseOrderItem: string }
  >();
  for (const rows of Object.values(ev.rows ?? {}))
    for (const r of rows ?? [])
      if (
        r?.PurchaseOrder &&
        r?.PurchaseOrderItem !== undefined &&
        r?.PurchaseOrderItem !== null &&
        r?.PurchaseOrderItem !== ""
      ) {
        const k = {
          PurchaseOrder: String(r.PurchaseOrder),
          PurchaseOrderItem: String(r.PurchaseOrderItem),
        };
        seen.set(itemKey(k), k);
      }
  return [...seen.values()];
}

/** The later of the snapshot's as-of and the event's simulated day. */
const dayOf = (ev: IngestEvent, ctx: StepContext) => {
  const d = ev.at ? ev.at.slice(0, 10) : ctx.asOf;
  return d > ctx.asOf ? d : ctx.asOf;
};

async function storeGrid(
  item: Row,
  r: Range,
  nOwn: number,
  snapshotId: string,
  trigger: GridTrigger,
  asOf: string,
  pool: number[],
) {
  await inTx(async () =>
    UPSERT.into(GRID_ENTITY).entries(
      lineGridRow(
        item,
        r.grid,
        r.source,
        nOwn,
        r.contextLevel,
        snapshotId,
        trigger,
        { asOf, pool, ageConditioned: r.ageConditioned },
        {
          runID: r.runID,
          inputFingerprint: r.inputFingerprint,
          backend: r.backend,
          trainingRows: r.trainingRows,
          fallback: r.fallback,
        },
      ),
    ),
  );
}

/** Hook po_item: verdict per new item; at risk → Finding (trigger arrived) + Event; every item → one Event. */
export async function onPoItem(
  ev: IngestEvent,
  ctx: StepContext,
): Promise<HookResult> {
  const events: HookResult["events"] = [];
  for (const k of keysOf(ev)) {
    const started = Date.now();
    await inTx(async () => {
      const live = await SELECT.one.from(FACT_LIVE).where(k);
      if (live) await UPSERT.into(FACT).entries(live);
    });
    const check = await verdictForItem(
      k.PurchaseOrder,
      k.PurchaseOrderItem,
      dayOf(ev, ctx),
      ctx.meter,
    );
    if (!check || check.gap === null) continue;
    const { item, verdict: v, range } = check;
    if (range)
      await storeGrid(
        item,
        range,
        check.nOwn,
        ctx.snapshotId,
        "arrived",
        dayOf(ev, ctx),
        check.history ?? [],
      );
    let id: string | null = null;
    if (v.atRisk) {
      const nm = await inTx(() =>
        names([item.Material], [item.Supplier], [item.Plant]),
      );
      const row = findingRow(
        {
          PurchaseOrder: item.PurchaseOrder,
          PurchaseOrderItem: item.PurchaseOrderItem,
          PurchasingGroup: item.PurchasingGroup ?? null,
          source: v.source,
          gap: check.gap,
          ruleVerdict: v.ruleVerdict,
          pLate: v.pLate,
          net: Number(item.NetAmountEUR ?? item.NetAmount ?? 0) || 0,
          item,
          plannedDays: check.plannedDays,
          nOwn: check.nOwn,
          grid: range?.grid ?? null,
          gridSource: range?.source ?? null,
          contextLevel: range?.contextLevel ?? null,
        },
        {
          rank: null,
          names: nm,
          arrived: true,
          snapshotId: ctx.snapshotId,
          asOf: dayOf(ev, ctx),
        },
      );
      await inTx(() => upsertDetectorCase(row));
      id = findingID("at_risk", itemKey(item));
    }
    events.push({
      kind: "po_item",
      title: `Delivery date check for ${itemKey(item)}: ${v.atRisk ? "may be late" : "no finding"}`,
      simTime: ev.at ?? null,
      findingID: id,
      objectKey: itemKey(item),
      source: v.source,
      status: v.atRisk ? "at risk" : "on time",
      modelCalls: range?.modelCalls ?? 0,
      latencyMs: Date.now() - started,
    } as any);
  }
  return { events };
}

/** Hook goods_receipt: close the item's at_risk row; new grid for open non-rule lines of the same key. */
export async function onGoodsReceipt(
  ev: IngestEvent,
  ctx: StepContext,
): Promise<HookResult> {
  const events: HookResult["events"] = [];
  for (const k of keysOf(ev)) {
    const started = Date.now();
    const reconciliation = await reconcileDeliveryProblem(
      k.PurchaseOrder,
      k.PurchaseOrderItem,
      "goods_receipt",
    );
    const closed = reconciliation.resolved;
    const re = await reestimateKey(k, ev, ctx);
    events.push({
      kind: "goods_receipt",
      title:
        `Goods receipt for ${itemKey(k)}: ${closed ? "delivery closed" : `${reconciliation.openQuantity} remains open`}` +
        (re.lines ? `, ${re.lines} other open line(s) estimated again` : ""),
      simTime: ev.at ?? null,
      findingID: closed ? findingID("at_risk", itemKey(k)) : null,
      objectKey: itemKey(k),
      source: re.source ?? "rule",
      status: closed ? "closed" : "received",
      modelCalls: re.modelCalls,
      latencyMs: Date.now() - started,
    } as any);
  }
  return { events };
}

/** As-of = posting date + 1 (the receipt is known); lines whose planned time is not usable get the new range. */
async function reestimateKey(
  k: { PurchaseOrder: string; PurchaseOrderItem: string },
  ev: IngestEvent,
  ctx: StepContext,
) {
  const none = { lines: 0, modelCalls: 0, source: null as Source | null };
  const item: Row | undefined = await inTx(async () =>
    SELECT.one
      .from(FACT_LIVE)
      .columns(
        "PurchaseOrder",
        "PurchaseOrderItem",
        "Material",
        "Supplier",
        "Plant",
        "AvailableDate",
      )
      .where(k),
  );
  if (!item?.Material) return none;
  const asOf = addDays(iso(item.AvailableDate) ?? dayOf(ev, ctx), 1);
  const same: Row[] = await inTx(
    async () =>
      SELECT.from(FACT_LIVE)
        .columns(
          "PurchaseOrder",
          "PurchaseOrderItem",
          "Material",
          "Supplier",
          "Plant",
          "PlannedDays",
          "PurchaseOrderDate",
          "RequestedDate",
        )
        .where({
          Material: item.Material,
          Supplier: item.Supplier,
          Plant: item.Plant,
          IsOpen: true,
        }).and`AvailableDate is null`,
  );
  const lines = same.filter((line) => itemKey(line) !== itemKey(k));
  if (!lines.length) return none;
  const hist = await ownHistory(item, asOf);
  const before = ctx.meter.runs.length;
  const model = await modelGrids(
    new Map([[item.Plant, lines]]),
    asOf,
    false,
    ctx.meter,
  );
  const rows = lines.flatMap((line) => {
    const result = model.get(itemKey(line));
    return result
      ? [
          lineGridRow(
            line,
            result.grid,
            result.source,
            hist.length,
            CTX_PLANT,
            ctx.snapshotId,
            "receipt",
            { asOf, ageConditioned: result.ageConditioned },
            {
              runID: result.runID,
              inputFingerprint: result.inputFingerprint,
              backend: result.backend,
              trainingRows: result.trainingRows,
              fallback: result.fallback,
            },
          ),
        ]
      : [];
  });
  if (!rows.length) return none;
  await inTx(async () => UPSERT.into(GRID_ENTITY).entries(rows));
  return {
    lines: rows.length,
    modelCalls: ctx.meter.runs.length - before,
    source: rows[0].source,
  };
}
