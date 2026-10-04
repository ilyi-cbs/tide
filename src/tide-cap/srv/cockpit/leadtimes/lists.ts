// P-4 planned delivery time list (info record level) and P-6 material master
// list: Finding rows of the lists `pdt` and `mm_pdt`.
import cds from "@sap/cds";
import {
  FEATURES,
  FEED,
  awaitRun,
  callCore,
  estimate,
  meterRun,
  runResults,
  type Meter,
  type Row,
} from "../kernel/model-calls";
import type { FindingRow } from "../kernel/types";
import { sourceText } from "../kernel/findings";
import {
  EMPIRICAL_MIN,
  MASTER_FLAG_TEXT,
  PROPOSAL_QUANTILE,
  bufferSimulator,
  currentValue,
  masterSignal,
  mmChain,
  mmIssue,
  mmIssueTechnical,
  mmProposals,
  mmSources,
  mmSourcesJson,
  mmTechnicalChain,
  ownRange,
  pdtChain,
  pdtCheck,
  pdtIssue,
  pdtIssueTechnical,
  pdtOrder,
  pdtProposal,
  pdtTechnicalChain,
  realistic,
  round1,
  serializeExpert,
  type MmProposal,
  type MmSource,
  type PdtRowInput,
} from "./domain/leadtimes";
import {
  activity,
  infoRecords,
  isStockTransfer,
  key,
  masters,
  names,
  ownLeadTimes,
  recentPos,
  type Names,
  type Own,
} from "./data";
import {
  materialSettingComparison,
  supplierSettingTrigger,
} from "./setting-check";

const { SELECT } = cds.ql;
export const NEXT_STEP = "Add to the change list";
/** A buyer worklist should surface the highest-value fixes, not every mismatch. */
export const MAX_PREVENTION_FINDINGS = 12;
const num = (v: unknown) =>
  v === null || v === undefined || v === "" ? null : Number(v);
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

export interface PdtInputs {
  asOf: string;
  ir: Map<string, Row>;
  master: Map<string, Row>;
  own: Map<string, Own[]>;
  act: Map<string, { n: number; value: number; PurchasingGroup?: string }>;
  nm: Names;
  settingRanges?: Map<string, Row>;
}

export async function pdtInputs(
  asOf: string,
  only?: { Material: string; Supplier: string; Plant: string },
): Promise<PdtInputs> {
  const [ir, master, own, act, nm] = await Promise.all([
    infoRecords(only),
    masters(only ? { Material: only.Material, Plant: only.Plant } : undefined),
    ownLeadTimes(asOf, only),
    activity(asOf, only),
    names(),
  ]);
  return { asOf, ir, master, own, act, nm };
}

const title = (nm: Names, m: string) =>
  `${m} · ${nm.material.get(m) ?? m}`.slice(0, 120);
const subtitle = (nm: Names, s: string | null, p: string) =>
  [s ? (nm.supplier.get(s) ?? `Supplier ${s}`) : null, `Plant ${p}`]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);

/** The pdt finding of one info record, or null when it is not relevant or not flagged. */
export function pdtFinding(
  k: string,
  inp: PdtInputs,
  trigger: "morning" | "arrived" = "morning",
): (FindingRow & { value12m: number; pos12m: number }) | null {
  const ir = inp.ir.get(k);
  if (!ir) return null;
  const act = inp.act.get(k);
  if (!act || act.n < 1) return null; // checked: ≥ 1 PO in the last 365 days
  const m = inp.master.get(`${ir.Material}|${ir.Plant}`);
  const irDays = num(ir.MaterialPlannedDeliveryDurn);
  const masterDays = num(m?.PlannedDeliveryDurationInDays);
  const cur = currentValue(irDays, masterDays);
  const byReceipt = (inp.own.get(k) ?? []).map((o) => o.lt);
  const settingRange = inp.settingRanges?.get(k);
  const modelTrigger =
    settingRange && supplierSettingTrigger(irDays, settingRange);
  if (!modelTrigger) return null;
  const check =
    pdtCheck(cur.days, byReceipt) ??
    (modelTrigger
      ? {
          verdict:
            irDays! < settingRange.p10
              ? ("below_range" as const)
              : ("above_range" as const),
          source: "rule" as const,
          p10: null,
          p50: null,
          p80: null,
          p90: null,
        }
      : null);
  if (!check) return null;
  const proposal = pdtProposal(byReceipt);
  const row: PdtRowInput = {
    current: cur.days,
    from: cur.from,
    check,
    proposal,
    nOwn: byReceipt.length,
  };
  const signal = masterSignal(irDays, masterDays);
  const backtest = bufferSimulator(byReceipt, cur.days);
  // Stored range for the object page (own history only; no model call on page load).
  const own = ownRange(
    { Material: ir.Material, Supplier: ir.Supplier, Plant: ir.Plant },
    byReceipt,
  );
  const detail = {
    proposalDays: proposal,
    proposalQuantile: PROPOSAL_QUANTILE,
    proposalRule:
      proposal === null
        ? `no proposal: fewer than ${EMPIRICAL_MIN} own lead times`
        : "ceil(p80) of own lead times",
    keyProposal:
      irDays !== null && realistic(irDays)
        ? { days: irDays, source: "lookup" }
        : { days: proposal, source: proposal === null ? "none" : "empirical" },
    currentDays: cur.days,
    currentFrom: cur.from,
    infoRecordDays: irDays,
    masterDays,
    masterSignal: signal,
    PurchasingInfoRecord: ir.PurchasingInfoRecord,
    verdict: check.verdict,
    nOwn: byReceipt.length,
    p10: check.p10,
    p50: check.p50,
    p80: check.p80,
    p90: check.p90,
    pos12m: act.n,
    value12mEUR: Math.round(act.value),
    backtest,
    range: own
      ? {
          source: own.source,
          n: own.n,
          p10: own.p10,
          p50: own.p50,
          p80: own.p80,
          p90: own.p90,
          sentence: own.sentence,
        }
      : null,
  };
  const signalText = signal
    ? `; material master says ${fmt(masterDays as number)} days`
    : "";
  return {
    list: "pdt",
    objectKey: k,
    Material: ir.Material,
    Supplier: ir.Supplier,
    Plant: ir.Plant,
    PurchasingGroup: ir.PurchasingGroup ?? act.PurchasingGroup ?? null,
    MRPController: m?.MRPResponsible ?? null,
    itemTitle: title(inp.nm, ir.Material),
    itemSubtitle: subtitle(inp.nm, ir.Supplier, ir.Plant),
    issue: (
      `Info record ${fmt(irDays!)} days: ${irDays! < settingRange.p10 ? "shorter" : "longer"} than independent delivery predictions` +
      signalText
    ).slice(0, 300),
    issueTechnical: (
      pdtIssueTechnical(row) +
      (signal
        ? `; info record ${irDays} vs material master ${masterDays} (≥ 2 days apart)`
        : "")
    ).slice(0, 300),
    impactText:
      check.p50 === null
        ? null
        : `Deliveries take about ${fmt(check.p50)} days`,
    impactCriticality: 0,
    nextStep: NEXT_STEP,
    nextActionKind: "pdt_change",
    changeAvailable: proposal !== null,
    source: modelTrigger ? "tabpfn" : check.source,
    chain: `Independent delivery predictions suggest checking the maintained info-record time. Next: ${NEXT_STEP}`,
    technicalChain: pdtTechnicalChain(row, trigger),
    trigger,
    pdtDetail: {
      proposalDays: detail.proposalDays,
      proposalQuantile: detail.proposalQuantile,
      proposalRule: detail.proposalRule,
      currentDays: detail.currentDays ?? null,
      currentFrom: detail.currentFrom ?? null,
      masterDays: detail.masterDays ?? null,
      purchasingInfoRecord: detail.PurchasingInfoRecord ?? null,
      ownDeliveries: detail.nOwn ?? null,
      p10: detail.p10 ?? null,
      p50: detail.p50 ?? null,
      p80: detail.p80 ?? null,
      p90: detail.p90 ?? null,
      orders12m: detail.pos12m ?? null,
      value12mEUR: detail.value12mEUR ?? null,
      rangeSource: detail.range?.source ?? null,
      rangeCount: detail.range?.n ?? null,
      rangeP10: detail.range?.p10 ?? null,
      rangeP50: detail.range?.p50 ?? null,
      rangeP80: detail.range?.p80 ?? null,
      rangeP90: detail.range?.p90 ?? null,
      rangeSentence: detail.range?.sentence ?? null,
      settingRecheck: modelTrigger
        ? "Imported info-record value outside independent model P10-P90"
        : null,
      settingRange: settingRange ?? null,
    },
    expert: serializeExpert(detail),
    value12m: act.value,
    pos12m: act.n,
  };
}

/** All pdt findings, ranked by 12-month EUR value desc, then PO count desc. */
export function pdtFindings(inp: PdtInputs): FindingRow[] {
  const rows = [...inp.ir.keys()]
    .map((k) => pdtFinding(k, inp))
    .filter((r): r is NonNullable<typeof r> => !!r);
  rows.sort(pdtOrder);
  return rows
    .slice(0, MAX_PREVENTION_FINDINGS)
    .map(({ value12m: _v, pos12m: _n, ...r }, i) => ({ ...r, rank: i + 1 }));
}

// ------------------------------------------------------------------ P-6

export interface MmInputs {
  asOf: string;
  sources: Map<string, MmSource[]>; // plant -> sources
  master: Map<string, Row>;
  nm: Names;
  reps: Map<string, string>; // M|S|P -> latest PO item key
  groups: Map<string, string>; // M|P -> purchasing group
  settingRanges?: Map<string, Row>;
  own?: PdtInputs["own"];
}

export async function mmInputs(asOf: string): Promise<MmInputs> {
  const [pos, master, own, ir, nm]: [
    Row[],
    Map<string, Row>,
    Map<string, Own[]>,
    Map<string, Row>,
    Names,
  ] = await Promise.all([
    recentPos(asOf),
    masters(),
    ownLeadTimes(asOf),
    infoRecords(),
    names(),
  ]);
  const byPlant = new Map<string, Row[]>();
  const reps = new Map<string, string>();
  const repDate = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const p of pos) {
    if (!p.Supplier) continue;
    (byPlant.get(p.Plant) ?? byPlant.set(p.Plant, []).get(p.Plant)!).push(p);
    const k = key(p.Material, p.Supplier, p.Plant);
    const itemKey = `${p.PurchaseOrder}/${p.PurchaseOrderItem}`;
    // Predict row of a source: its latest PO item in the window.
    if (!reps.has(k) || p.PurchaseOrderDate >= repDate.get(k)!) {
      reps.set(k, itemKey);
      repDate.set(k, p.PurchaseOrderDate);
    }
    if (p.PurchasingGroup)
      groups.set(`${p.Material}|${p.Plant}`, p.PurchasingGroup);
  }
  const sources = new Map<string, MmSource[]>();
  for (const [plant, list] of byPlant) {
    const transfer = new Set(
      list
        .map((p) => p.Material)
        .filter((m) => isStockTransfer(master.get(`${m}|${plant}`))),
    );
    sources.set(
      plant,
      mmSources(
        list as any,
        asOf,
        transfer,
        (m, s) => (own.get(key(m, s, plant)) ?? []).map((o) => o.lt),
        (m, s) => num(ir.get(key(m, s, plant))?.MaterialPlannedDeliveryDurn),
      ),
    );
  }
  return { asOf, sources, master, nm, reps, groups, own };
}

/** Plant context spec for the p50 of all sources below 20 own lead times (one call per plant). */
function mmSpec(plant: string, asOf: string, keys: string[]) {
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
      ],
    },
    predict: { keys },
    output: { type: "quantiles", levels: [0.5] },
  };
}

/**
 * Fills the medians of sources without enough own history: ONE model call per
 * plant. A fallback (no varying feature) marks them empirical; a failed run
 * or no context leaves them without a median (source none).
 */
export async function estimateMedians(
  inp: MmInputs,
  meter: Meter,
  dryRun: boolean,
): Promise<Record<string, string>> {
  const notes: Record<string, string> = {};
  for (const [plant, list] of inp.sources) {
    const need = list.filter((s) => s.source === "tabpfn");
    const keys = [
      ...new Set(
        need
          .map((s) => inp.reps.get(key(s.Material, s.Supplier, plant)))
          .filter((k): k is string => !!k),
      ),
    ];
    if (!keys.length) continue;
    const spec = mmSpec(plant, inp.asOf, keys);
    if (dryRun) {
      await estimate(meter, `material master ${plant}`, spec);
      continue;
    }
    let run: any;
    try {
      run = await callCore(meter.user, "predict", { spec });
    } catch (e: any) {
      // Budget refused (429) or no context: the sources stay without a median.
      for (const s of need) s.source = "none";
      notes[plant] = `no model call: ${e?.code ?? e?.status ?? "error"}`;
      meter.failed.push(
        `material master ${plant}: ${e?.code ?? e?.status ?? "error"}`,
      );
      continue;
    }
    const done =
      run.status === "succeeded" ? run : await awaitRun(meter.user, run.ID);
    meter.runs.push(run.ID);
    if (done.status !== "succeeded") {
      for (const s of need) s.source = "none";
      meter.failed.push(`material master ${plant}: ${done.errorCode}`);
      notes[plant] = `run failed: ${done.errorCode}`;
      continue;
    }
    meterRun(meter, done, run.status === "succeeded");
    const full: Row | undefined = await SELECT.one
      .from("tide.core.PredictionRun")
      .columns("fallback", "backend")
      .where({ ID: run.ID });
    meter.backend = full?.backend ?? meter.backend;
    const res = await runResults(run.ID);
    for (const s of need) {
      const q = res.get(inp.reps.get(key(s.Material, s.Supplier, plant)) ?? "");
      if (!q?.length) {
        s.source = "none";
        continue;
      }
      s.median = round1(Math.max(0, Number(q[0])));
      if (full?.fallback) s.source = "fallback";
    }
    if (full?.fallback)
      notes[plant] = `plant lead time median (${full.fallback})`;
  }
  return notes;
}

export function mmFinding(
  p: MmProposal,
  plant: string,
  inp: MmInputs,
  note?: string,
  pdtIDs: Set<string> = new Set(),
  trigger: "morning" | "arrived" = "morning",
): FindingRow {
  const m = inp.master.get(`${p.Material}|${plant}`);
  const model = p.sources.some(
    (s) => s.source === "tabpfn" && s.median !== null,
  );
  const diff = p.difference;
  return {
    list: "mm_pdt",
    objectKey: `${p.Material}|${plant}`,
    Material: p.Material,
    Supplier: null,
    Plant: plant,
    PurchasingGroup: inp.groups.get(`${p.Material}|${plant}`) ?? null,
    MRPController: m?.MRPResponsible ?? null,
    itemTitle: title(inp.nm, p.Material),
    itemSubtitle: `Plant ${plant} · ${p.sources.length} supplier${p.sources.length === 1 ? "" : "s"}`,
    issue: mmIssue(p).slice(0, 300),
    issueTechnical: mmIssueTechnical(p),
    impactText:
      diff === null
        ? "Not set"
        : `${fmt(Math.abs(diff))} days too ${diff < 0 ? "short" : "long"}`,
    impactCriticality: 0,
    nextStep: NEXT_STEP,
    nextActionKind: "pdt_change",
    changeAvailable: Number.isInteger(p.proposal) && (p.proposal ?? 0) > 0,
    source: model ? "tabpfn" : "empirical",
    chain: mmChain(p, trigger).slice(0, 1000),
    technicalChain: mmTechnicalChain(p, trigger),
    trigger,
    mmPdtDetail: {
      proposalDays: p.proposal,
      proposalRule:
        "order-share weighted median lead time of the sources in the last 12 months, rounded up",
      masterDays: p.master,
      masterFlag: p.masterFlag ? MASTER_FLAG_TEXT[p.masterFlag] : null,
      difference: p.difference,
      tolerance: p.tolerance,
      orders12m: p.pos,
      note: note ?? null,
      sources: mmSourcesJson(p, plant).map((s) => ({
        supplier: s.Supplier,
        supplierName: inp.nm.supplier.get(s.Supplier) ?? null,
        orders12m: s.pos ?? null,
        orderShare: s.share ?? null,
        ownDeliveries: s.nOwn ?? null,
        typicalDays: s.median ?? null,
        infoRecordDays: s.infoRecordDays ?? null,
        source: s.source ?? null,
        pdtFindingID: pdtIDs.has(s.findingID) ? s.findingID : null,
      })),
    },
    expert: serializeExpert({
      proposalDays: p.proposal,
      proposalRule:
        "order-share weighted median lead time of the sources in the last 12 months, rounded up",
      masterDays: p.master,
      masterFlag: p.masterFlag,
      difference: p.difference,
      tolerance: p.tolerance,
      pos12m: p.pos,
      note: note ?? null,
      sources: mmSourcesJson(p, plant).map((s) => ({
        ...s,
        supplierName: inp.nm.supplier.get(s.Supplier) ?? null,
        sourceText: sourceText(s.source),
        findingID: pdtIDs.has(s.findingID) ? s.findingID : null,
      })),
    }),
  } as FindingRow;
}

/** All mm_pdt findings (mismatches), PO count desc. */
export function mmFindings(
  inp: MmInputs,
  notes: Record<string, string> = {},
  pdtIDs: Set<string> = new Set(),
): FindingRow[] {
  const all: {
    p: MmProposal;
    plant: string;
    comparison: ReturnType<typeof materialSettingComparison>;
  }[] = [];
  for (const [plant, list] of inp.sources)
    for (const p of mmProposals(list, (mat) =>
      num(inp.master.get(`${mat}|${plant}`)?.PlannedDeliveryDurationInDays),
    )) {
      const comparison = materialSettingComparison(
        p.master,
        p.sources.map((source) => ({
          orders: source.pos,
          range: inp.settingRanges?.get(
            key(p.Material, source.Supplier, plant),
          ),
        })),
      );
      if (comparison.trigger) all.push({ p, plant, comparison });
    }
  all.sort(
    (a, b) =>
      b.p.pos - a.p.pos ||
      a.p.Material.localeCompare(b.p.Material) ||
      a.plant.localeCompare(b.plant),
  );
  return all
    .slice(0, MAX_PREVENTION_FINDINGS)
    .map(({ p, plant, comparison }, i) => {
      const row = mmFinding(p, plant, inp, notes[plant], pdtIDs);
      if (comparison.trigger) {
        row.source = "tabpfn";
        const difference = comparison.value! - p.master!;
        row.issue = `Material master ${fmt(p.master!)} days: ${fmt(Math.abs(difference))} days ${difference > 0 ? "below" : "above"} independent supplier predictions`;
        row.impactText = `${fmt(Math.abs(difference))} days from the independent model comparator`;
        row.chain = `Independent supplier predictions suggest checking the maintained material-master time. Next: ${NEXT_STEP}`;
      }
      (row as any).mmPdtDetail.settingComparison = comparison;
      (row as any).mmPdtDetail.settingSources = p.sources.map((source) => ({
        Supplier: source.Supplier,
        orders: source.pos,
        range:
          inp.settingRanges?.get(key(p.Material, source.Supplier, plant)) ??
          null,
        empiricalRange: ownRange(
          { Material: p.Material, Supplier: source.Supplier, Plant: plant },
          (inp.own?.get(key(p.Material, source.Supplier, plant)) ?? []).map(
            (receipt) => receipt.lt,
          ),
        ),
      }));
      return { ...row, rank: i + 1 };
    });
}
