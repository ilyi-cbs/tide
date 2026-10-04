// Feature "freetext" (P-14): free-text coding of purchase requisitions.
// Morning step (proposals for every open request, one call per segment and
// field), ingest hook (new request → proposals → new finding), service
// operations (proposeCodes, similarRequests, thresholdSimulator,
// acceptConfidentCodes, acceptAllConfidentCodes, calibrateFreetext).
import cds from "@sap/cds";
import { registerRequisitionCommands } from "./commands";
import { modelWork } from "../kernel/model-calls";
import { resolveFromSource } from "../kernel/cases";
import { registerHook } from "../kernel/hooks";
import { registerActionTransition } from "../kernel/action-listeners";
import { inTx, NS, type Meter, type Row } from "../kernel/model-calls";
import { writePreparation } from "../kernel/publication";
import type {
  FindingRow,
  IngestEvent,
  Source,
  Step,
  StepContext,
} from "../kernel/types";
import { addDays } from "../kernel/calendar";
import { runCost } from "../kernel/stats";
import { coreClassify, dryClassify } from "./classify";
import {
  predictAllocationFieldsV5,
  applyAllocationSelectionsV5,
  confirmAllocationValueV5,
} from "./allocation";
import {
  applyPredictionSelections,
  applyDraftSuggestionV5,
  confirmDraftValueV5,
  predictDraftFieldsV5,
  reviewWorkspaceV5,
} from "./review";
import {
  applyRouting,
  buildItems,
  deleteItems,
  isFreeText,
  labelledOf,
  readItems,
  shownOpen,
  type StoredItem,
  upsertItems,
  writeItems,
} from "./data";
import {
  calibrate,
  columnsFor,
  plan,
  propose,
  type CalibrationRow,
  type StoredThreshold,
} from "./engine";
import {
  applyDraftSuggestion,
  applyProvisionalSuggestions,
  closeMissingWorkItems,
  closeRemovedWorkItems,
  confirmCurrentValues,
  confirmDraftValue,
  ensureMissingReviews,
  guardDraftAssistanceRead,
  guardProposalRead,
  guardReview,
  guardReviewAssignment,
  guardReviewRead,
  guardWorkRead,
  markEnrichment,
  markPending,
  markReviewInProgress,
  predictDraftFields,
  reconcileAction,
  reconcileReview,
  requestWorkflowSummary,
  submitReview,
  syncWorkItems,
  requireBuyer,
  validateReview,
  reviewWorkspace,
  reviewOrder,
  submitReviewedOrder,
  exportOrderDraft,
} from "./review";
import {
  CONTEXT_ROWS,
  DEFAULT_FIELDS,
  FIELD_TEXT,
  FIELDS,
  PREDICTION_FIELDS,
  freetextChain,
  ISSUE,
  itemKey,
  NEXT_STEP,
  type Proposal,
  proposalWords,
  rightOf100,
  sameValueText,
  segmentContext,
  segmentOf,
  segmentSets,
  similarItems,
  status as statusOf,
  STATUS_TEXT,
  thresholdCurve,
} from "./domain/logic";

const { SELECT, INSERT, DELETE, UPDATE } = cds.ql;
const LOG = cds.log("cockpit");
const PROPOSAL = `${NS}.FreetextProposal`;
const THRESHOLD = `${NS}.FreetextThreshold`;
const CRITICALITY: Record<string, number> = {
  prefilled: 3,
  review: 2,
  no_threshold: 2,
  never_automatic: 0,
};

/** Root transaction: model runs read the feed rows from other connections, so writes must be committed. */
const tx = inTx;

// ------------------------------------------------------------ thresholds

async function thresholds(): Promise<StoredThreshold[]> {
  const rows: Row[] = await tx(async () =>
    SELECT.from(THRESHOLD).columns(
      "field",
      "segment",
      "threshold",
      "accuracyAtThreshold",
      "contextRows",
    ),
  );
  return rows as StoredThreshold[];
}

function info(t: StoredThreshold | undefined) {
  return t
    ? {
        threshold: t.threshold,
        accuracyAtThreshold: t.accuracyAtThreshold,
        valid: t.contextRows === CONTEXT_ROWS,
      }
    : null;
}

// ------------------------------------------------------------ rows

function similarFor(labelled: StoredItem[], it: StoredItem) {
  const sets = segmentSets(labelled, "MaterialGroup");
  const seg = segmentOf(sets, it.Plant, it.PurchasingOrganization);
  return similarItems(
    segmentContext(labelled, sets, seg, "MaterialGroup").context,
    it.text,
  );
}

async function proposalRows(
  it: StoredItem,
  props: Proposal[],
  similar: Row[],
  snapshotId: string | null,
) {
  const now = new Date().toISOString();
  const work = await tx(async () =>
    SELECT.one
      .from(`${NS}.FreetextWorkItem`)
      .columns("sourceRevision", "sourceFingerprint")
      .where({
        PurchaseRequisition: it.PurchaseRequisition,
        PurchaseRequisitionItem: it.PurchaseRequisitionItem,
      }),
  );
  const calibration = new Map(
    (
      await tx(async () =>
        SELECT.from(THRESHOLD).columns(
          "field",
          "segment",
          "accuracyAtThreshold",
        ),
      )
    ).map((row: Row) => [
      `${row.field}|${row.segment}`,
      row.accuracyAtThreshold,
    ]),
  );
  return props.map((p, i) => ({
    PurchaseRequisition: it.PurchaseRequisition,
    PurchaseRequisitionItem: it.PurchaseRequisitionItem,
    field: p.field,
    snapshot_ID: snapshotId,
    rank: i + 1,
    fieldText: FIELD_TEXT[p.field] ?? p.field,
    value: p.value,
    confidence: p.confidence,
    modelScore: p.confidence,
    modelVersion: p.modelVersion ?? null,
    backend: p.backend ?? null,
    isDemo: !!it.demo,
    historicalReliability: calibration.get(`${p.field}|${p.segment}`) ?? null,
    status: p.status,
    statusText: STATUS_TEXT[p.status],
    statusCriticality: CRITICALITY[p.status] ?? 0,
    rightOf100: p.rightOf100,
    words: proposalWords(p),
    similarSame: sameValueText(similar, p.field, p.value),
    source: p.source as Source,
    segment: p.segment,
    alternatives: JSON.stringify(p.alternatives),
    reason: p.reason ?? null,
    computedAt: now,
    sourceRevision: work?.sourceRevision ?? null,
    sourceFingerprint: work?.sourceFingerprint ?? null,
  }));
}

const rowSource = (props: Proposal[]): Source =>
  props.some((p) => p.source === "tabpfn")
    ? "tabpfn"
    : props.some((p) => p.source === "fallback")
      ? "fallback"
      : "none";

function codesText(props: Proposal[]) {
  return props
    .map(
      (p) =>
        `${FIELD_TEXT[p.field] ?? p.field} ${p.value ?? "–"}: ${STATUS_TEXT[p.status]}`,
    )
    .join("; ");
}

export function findingRow(
  it: StoredItem,
  props: Proposal[],
  opt: {
    snapshotId: string | null;
    rank: number | null;
    trigger: "morning" | "arrived";
    arrivedAt?: string | null;
  },
): FindingRow {
  const { chain, technicalChain } = freetextChain(opt.trigger, props);
  const text = it.text || "(no text)";
  return {
    snapshot_ID: opt.snapshotId,
    list: "freetext",
    objectKey: itemKey(it),
    PurchaseRequisition: it.PurchaseRequisition,
    PurchaseRequisitionItem: it.PurchaseRequisitionItem,
    Plant: it.Plant,
    PurchasingGroup: it.routedGroup ?? null,
    itemTitle: `${itemKey(it)} · ${text}`.slice(0, 120),
    itemSubtitle: [
      it.Plant && `Plant ${it.Plant}`,
      it.PurchasingOrganization &&
        `Purchasing org ${it.PurchasingOrganization}`,
    ]
      .filter(Boolean)
      .join(" · "),
    issue: ISSUE,
    issueTechnical: props
      .map(
        (p) =>
          `${p.field} ${p.value ?? "–"} (${p.confidence ?? "–"}, ${p.status}, ${p.segment})`,
      )
      .join("; ")
      .slice(0, 300),
    dueDate: it.DeliveryDate ?? null,
    nextStep: NEXT_STEP,
    nextActionKind: null,
    source: rowSource(props),
    chain,
    technicalChain,
    trigger: opt.trigger,
    status: "open",
    arrivedAt: opt.arrivedAt ?? null,
    rank: opt.rank,
    freetextDetail: {
      requestedAt: it.date,
      requestText: text.slice(0, 255),
      codingText: codesText(props).slice(0, 300),
      segment:
        props.find((p) => p.field === "PurchasingGroup")?.segment ??
        props[0]?.segment ??
        null,
      demo: !!it.demo,
      contextRows: CONTEXT_ROWS,
      inputs: JSON.stringify(
        [
          ...columnsFor("MaterialGroup").map((c) => c.name),
          "PurchasingGroup",
        ].filter((c, i, a) => a.indexOf(c) === i),
      ),
    },
  } as FindingRow;
}

// ------------------------------------------------------------ dry run

/** Counts the planned calls (one per segment and field) without writing or sending anything. */
function countPlanned(
  meter: Meter,
  labelled: StoredItem[],
  open: StoredItem[],
) {
  for (const c of plan(labelled, open, DEFAULT_FIELDS)) {
    if (
      c.train.length < 5 ||
      new Set(c.train.map((r) => (r as any)[c.field])).size < 2
    )
      continue;
    meter.planned.push(`freetext ${c.field} ${c.segment}`);
    meter.calls += 1;
    meter.cost += runCost({
      calls: 1,
      trainRows: c.train.length,
      testRows: c.test.length,
      columns: columnsFor(c.field).length,
    });
  }
}

// ------------------------------------------------------------ step

export const step: Step = {
  name: "freetext",
  async run(ctx: StepContext) {
    const items = await applyRouting(
      await tx(async () => buildItems(ctx.asOf)),
      ctx.publication?.buyers,
    );
    const labelled = labelledOf(items);
    const open = await tx(async () =>
      shownOpen(items, ctx.publication?.buyers),
    );
    if (ctx.dryRun) {
      countPlanned(ctx.meter, labelled, open);
      return;
    }
    const existing: Row[] = await tx(async () =>
      SELECT.from(`${NS}.FreetextWorkItem`).columns(
        "PurchaseRequisition",
        "PurchaseRequisitionItem",
      ),
    );
    const existingKeys = new Set(
      existing.map(
        (x) => `${x.PurchaseRequisition}/${x.PurchaseRequisitionItem}`,
      ),
    );
    const prefix = `${cds.utils.uuid()}:`;
    const staged = items.map((item) => ({
      ...item,
      id: `${prefix}${item.id}`,
      isQuery: true,
    }));
    const classify = coreClassify(ctx.meter);
    let props: Map<string, Proposal[]>;
    try {
      await upsertItems(staged);
      props = open.length
        ? await propose(labelled, open, {
            fields: DEFAULT_FIELDS,
            thresholds: await thresholds(),
            classify: (request) =>
              classify({
                ...request,
                train: request.train.map((item) => ({
                  ...item,
                  id: `${prefix}${"id" in item && typeof item.id === "string" ? item.id : itemKey(item)}`,
                })),
                test: request.test.map((item) => ({
                  ...item,
                  id: `${prefix}${"id" in item && typeof item.id === "string" ? item.id : itemKey(item)}`,
                })),
              }),
          })
        : new Map<string, Proposal[]>();
    } finally {
      await deleteItems(staged.map((item) => item.id));
    }
    const ordered = [...open].sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : a.id.localeCompare(b.id),
    );
    await writePreparation(ctx, async () => {
      await writeItems(items, "current");
      await syncWorkItems(
        items.filter((item) => item.isOpen || existingKeys.has(itemKey(item))),
      );
      await markPending(open);
      const proposalRecords: Row[] = [];
      for (const item of ordered)
        proposalRecords.push(
          ...(await proposalRows(
            item,
            props.get(item.id)!,
            similarFor(labelled, item),
            ctx.snapshotId,
          )),
        );
      for (const it of ordered)
        await DELETE.from(PROPOSAL).where({
          PurchaseRequisition: it.PurchaseRequisition,
          PurchaseRequisitionItem: it.PurchaseRequisitionItem,
        });
      if (proposalRecords.length)
        await INSERT.into(PROPOSAL).entries(proposalRecords);
      await closeMissingWorkItems(
        new Set(items.filter((item) => item.isOpen).map(itemKey)),
      );
      for (const item of open) await markEnrichment(item, props.get(item.id)!);
    });
    const demo = open.filter((i) => i.demo).length;
    LOG.info(
      `freetext: ${open.length} open request(s)${demo ? ` (${demo} demo)` : ""}, ${labelled.length} coded ones as context`,
    );
  },
};

// ------------------------------------------------------------ hook

/** Requisition items of an ingest event (entity set PurchaseReqnItem / PurchaseRequisitionItem). */
function ingestedItems(ev: IngestEvent): Row[] {
  return Object.entries(ev.rows ?? {})
    .filter(([entity]) => /^(A_)?PurchaseR(eqn|equisition)Item$/.test(entity))
    .flatMap(([, rows]) => rows ?? [])
    .filter(isFreeText);
}

export async function onFreetext(ev: IngestEvent, ctx: StepContext) {
  const events: Row[] = [];
  const rows = ingestedItems(ev);
  if (!rows.length) return { events };
  const simDay = String(ev.at ?? ctx.asOf).slice(0, 10);
  const keys = rows.map((r) => ({
    PurchaseRequisition: String(r.PurchaseRequisition),
    PurchaseRequisitionItem: String(r.PurchaseRequisitionItem),
  }));
  const fresh = (
    await tx(async () =>
      buildItems(addDays(simDay > ctx.asOf ? simDay : ctx.asOf, 1), keys),
    )
  ).filter((i) => i.isOpen);
  if (!fresh.length) {
    const closed = await tx(async () =>
      buildItems(addDays(simDay > ctx.asOf ? simDay : ctx.asOf, 1), keys),
    );
    await syncWorkItems(closed);
    await closeRemovedWorkItems(keys, new Set(closed.map(itemKey)));
  }
  if (!fresh.length) return { events };
  const stored = await readItems();
  const labelled = labelledOf(stored);
  const routed = (
    await applyRouting([
      ...stored.filter((s) => !fresh.some((f) => f.id === s.id)),
      ...fresh,
    ])
  ).filter((i) => fresh.some((f) => f.id === i.id));
  await upsertItems(routed);
  await syncWorkItems(routed);
  await markPending(routed);
  const started = Date.now();
  const calls0 = ctx.meter.calls;
  const cost0 = ctx.meter.cost;
  const props = await propose(labelled, routed, {
    fields: DEFAULT_FIELDS,
    thresholds: await thresholds(),
    classify: coreClassify(ctx.meter),
  });
  for (const it of routed) {
    const p = props.get(it.id)!;
    await tx(async () => {
      await DELETE.from(PROPOSAL).where({
        PurchaseRequisition: it.PurchaseRequisition,
        PurchaseRequisitionItem: it.PurchaseRequisitionItem,
      });
      await INSERT.into(PROPOSAL).entries(
        await proposalRows(it, p, similarFor(labelled, it), ctx.snapshotId),
      );
    });
    await markEnrichment(it, p);
    const n = p.filter((x) => x.status === "prefilled").length;
    events.push({
      kind: "freetext",
      title: `Free-text request ${itemKey(it)}: codes proposed, ${n} of ${p.length} pre-filled`,
      simTime: ev.at ?? null,
      findingID: `requisition:${itemKey(it)}`,
      objectKey: itemKey(it),
      source: rowSource(p),
      status: "new",
      modelCalls: ctx.meter.calls - calls0,
      costUnits: ctx.meter.cost - cost0,
      latencyMs: Date.now() - started,
    } as any);
  }
  return { events };
}

/** Reconcile changed, converted, deleted or closed PRs without running the model. */
export async function refreshFreetextSources(rows: Row[], asOf: string) {
  const keys = rows
    .filter((r) => r.PurchaseRequisition && r.PurchaseRequisitionItem)
    .map((r) => ({
      PurchaseRequisition: String(r.PurchaseRequisition),
      PurchaseRequisitionItem: String(r.PurchaseRequisitionItem),
    }));
  if (!keys.length) return;
  const items = await tx(async () => buildItems(addDays(asOf, 1), keys));
  const routed = await applyRouting(items);
  await syncWorkItems(routed);
  await closeRemovedWorkItems(keys, new Set(routed.map(itemKey)));
  for (const i of routed.filter((x) => !x.isOpen))
    await resolveFromSource(
      `requisition:${itemKey(i)}`,
      "The purchase requisition item is closed at the source.",
    );
}

// ------------------------------------------------------------ operations

function meterFor(user: cds.User): Meter {
  return {
    user,
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  };
}

const fail = (req: cds.Request, status: number, message: string) =>
  req.reject(status, message);

async function proposeCodes(req: cds.Request) {
  const {
    text,
    Plant,
    PurchasingOrganization,
    PurchaseOrderType,
    withSupplier,
  } = req.data as Row;
  if (!text || !String(text).trim())
    return fail(req, 400, "Enter the request text");
  const stored = await readItems();
  const labelled = labelledOf(stored);
  const id = `Q/${cds.utils.uuid()}`;
  const query: StoredItem = {
    id,
    PurchaseRequisition: "Q",
    PurchaseRequisitionItem: id.slice(2, 40),
    text: String(text).slice(0, 255),
    Plant: Plant ?? null,
    PurchasingOrganization: PurchasingOrganization ?? null,
    PurchaseOrderType: PurchaseOrderType ?? null,
    date: new Date().toISOString().slice(0, 10),
    isOpen: true,
    isQuery: true,
  };
  const fields = withSupplier ? PREDICTION_FIELDS : DEFAULT_FIELDS;
  await upsertItems([query]);
  try {
    const props = await propose(
      labelled,
      [{ ...query, id: itemKey(query) } as StoredItem],
      {
        fields,
        thresholds: await thresholds(),
        classify: coreClassify(meterFor(req.user)),
      },
    );
    const similar = similarFor(labelled, query);
    return (props.get(itemKey(query)) ?? []).map((p) => ({
      field: p.field,
      value: p.value,
      text: [proposalWords(p), sameValueText(similar, p.field, p.value)]
        .filter(Boolean)
        .join(" · "),
      confidence: p.confidence,
      status: p.status,
      rightOf100: p.rightOf100,
      source: p.source,
    }));
  } finally {
    await deleteItems([id]);
  }
}

async function similarRequests(req: cds.Request) {
  const caseID = String(req.data.caseID ?? req.data.findingID ?? "").replace(
    /^freetext:/,
    "requisition:",
  );
  const review: Row = await tx(async () =>
    SELECT.one.from(`${NS}.RequisitionReviews`).where({ header_ID: caseID }),
  );
  if (!review) return fail(req, 404, "Requisition review not found");
  const stored = await readItems();
  const it = stored.find(
    (s) =>
      s.PurchaseRequisition === review.PurchaseRequisition &&
      s.PurchaseRequisitionItem === review.PurchaseRequisitionItem,
  );
  if (!it) return [];
  return similarFor(labelledOf(stored), it).map((s) => ({
    caseID,
    PurchaseRequisition: s.PurchaseRequisition,
    PurchaseRequisitionItem: s.PurchaseRequisitionItem,
    text: s.text,
    similarity: s.similarity,
    MaterialGroup: s.MaterialGroup ?? null,
    PurchasingGroup: s.PurchasingGroup ?? null,
    Supplier: s.Supplier ?? null,
  }));
}

async function thresholdSimulator(req: cds.Request) {
  const field = String(req.data.field ?? "PurchasingGroup");
  const segment = String(req.data.segment ?? "");
  if (!(PREDICTION_FIELDS as readonly string[]).includes(field))
    return fail(
      req,
      400,
      `field must be one of ${PREDICTION_FIELDS.join(", ")}`,
    );
  const t: Row = await tx(async () =>
    SELECT.one.from(THRESHOLD).where({ field, segment }),
  );
  if (!t?.holdout) return [];
  const h = JSON.parse(t.holdout) as { conf: number[]; correct: number[] };
  const valid = t.contextRows === CONTEXT_ROWS;
  return thresholdCurve(h.conf, h.correct, valid ? t.threshold : null);
}

async function acceptConfidentCodes(req: cds.Request) {
  return fail(
    req,
    409,
    "Open the requisition review and submit its reviewed values for approval",
  );
}

async function acceptAllConfidentCodes(req: cds.Request) {
  return fail(
    req,
    409,
    "Open each requisition review and submit its reviewed values for approval",
  );
}

/** Recomputes the statuses of the stored proposals from the stored thresholds (no model call). */
export async function restatus() {
  const byKey = new Map(
    (await thresholds()).map((t) => [`${t.field}|${t.segment}`, t]),
  );
  const props: Row[] = await tx(async () => SELECT.from(PROPOSAL));
  for (const p of props) {
    const thr = info(byKey.get(`${p.field}|${p.segment}`));
    const status =
      p.value === null
        ? statusOf(p.field, null, thr)
        : p.source === "fallback" && p.field === "PurchasingGroup"
          ? "review"
          : statusOf(p.field, p.confidence, thr);
    const r100 = status === "prefilled" ? rightOf100(thr) : null;
    await tx(async () =>
      UPDATE.entity(PROPOSAL)
        .set({
          status,
          statusText: STATUS_TEXT[status],
          statusCriticality: CRITICALITY[status] ?? 0,
          rightOf100: r100,
          words: proposalWords({ value: p.value, status, rightOf100: r100 }),
        })
        .where({
          PurchaseRequisition: p.PurchaseRequisition,
          PurchaseRequisitionItem: p.PurchaseRequisitionItem,
          field: p.field,
        }),
    );
  }
  const fresh: Row[] = await tx(async () =>
    SELECT.from(PROPOSAL).orderBy("rank"),
  );
  const byItem = new Map<string, Row[]>();
  for (const p of fresh) {
    const k = `${p.PurchaseRequisition}/${p.PurchaseRequisitionItem}`;
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k)!.push(p);
  }
  for (const [k, ps] of byItem)
    await tx(async () =>
      UPDATE.entity(`${NS}.FreetextDetail`)
        .set({ codingText: codesText(ps as any).slice(0, 300) })
        .where({ finding_ID: `freetext:${k}` }),
    );
}

function thresholdRecord(r: CalibrationRow) {
  return {
    field: r.field,
    segment: r.segment,
    threshold: r.threshold,
    accuracyAtThreshold: r.accuracyAtThreshold,
    target: r.target,
    contextRows: r.contextRows,
    holdoutRows: r.holdoutRows,
    trainRows: r.trainRows,
    holdoutAccuracy: r.holdoutAccuracy,
    coverage: r.coverage,
    reason: r.reason ?? null,
    holdout: r.conf.length
      ? JSON.stringify({ conf: r.conf, correct: r.correct })
      : null,
    createdAt: new Date().toISOString(),
  };
}

async function calibrateFreetext(req: cds.Request) {
  const dryRun = !!req.data.dryRun;
  const labelled = labelledOf(await readItems());
  const meter = meterFor(req.user);
  const rows = await calibrate(
    labelled,
    dryRun ? dryClassify(meter) : coreClassify(meter),
  );
  const out = rows.map(thresholdRecord);
  if (dryRun)
    return out.map(({ holdout: _h, ...r }) => ({
      ...r,
      threshold: null,
      accuracyAtThreshold: null,
      reason: `dry run: ${meter.calls} call(s) planned, ${meter.cost.toFixed(4)} cost units${meter.failed.length ? `, ${meter.failed.length} failed` : ""}`,
    }));
  await tx(async () => {
    await DELETE.from(THRESHOLD);
    if (out.length) await INSERT.into(THRESHOLD).entries(out);
  });
  await restatus();
  return out.map(({ holdout: _h, ...r }) => r);
}

/** Wraps a handler: errors carrying a status become request rejections. */
const handle =
  (fn: (req: cds.Request) => Promise<any>) => async (req: cds.Request) => {
    try {
      return await fn(req);
    } catch (e: any) {
      const status = e?.status ?? e?.statusCode;
      if (status && status < 500 && !e?.code)
        return req.reject(status, e.message);
      throw e;
    }
  };

export function register(srv: cds.Service) {
  const reviews = [
    "PurchaseRequisitionReviews",
    "PurchaseRequisitionReviews.drafts",
  ];
  srv.on(
    "predictAllocationFieldsV5",
    reviews,
    handle(predictAllocationFieldsV5),
  );
  srv.on(
    "applyAllocationSelectionsV5",
    reviews,
    handle(async (req) => {
      await applyAllocationSelectionsV5(req);
      return reviewWorkspaceV5(req);
    }),
  );
  srv.on(
    "confirmAllocationValueV5",
    reviews,
    handle(async (req) => {
      await confirmAllocationValueV5(req);
      return reviewWorkspaceV5(req);
    }),
  );
  registerRequisitionCommands(srv);
  srv.on("requestsWorkflowSummary", (req) => requestWorkflowSummary(req.user));
  if (!(srv as any)._freetextActionListener) {
    (srv as any)._freetextActionListener = true;
    registerActionTransition(async ({ ID, kind, status, resolution }) => {
      if (kind === "pr_review") await reconcileAction(ID, status, resolution);
    });
  }
  srv.before(
    "READ",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    guardReviewRead,
  );
  srv.before("READ", "FreetextWorkItems", guardWorkRead);
  srv.before("READ", "FreetextProposals", guardProposalRead);
  srv.before(
    "READ",
    [
      "FreetextDraftEvidences",
      "FreetextDraftEvidences.drafts",
      "FreetextDraftDecisions",
      "FreetextDraftDecisions.drafts",
      "FreetextAllocationEvidences",
      "FreetextAllocationEvidences.drafts",
      "FreetextAllocationDecisions",
      "FreetextAllocationDecisions.drafts",
    ],
    guardDraftAssistanceRead,
  );
  srv.before(
    ["PATCH", "UPDATE"],
    "PurchaseRequisitionReviews.drafts",
    guardReview,
  );
  srv.before("SAVE", "PurchaseRequisitionReviews.drafts", guardReview);
  srv.before(
    ["CREATE", "UPDATE", "PATCH", "DELETE"],
    [
      "FreetextReviewAccountAssignments",
      "FreetextReviewAccountAssignments.drafts",
    ],
    guardReviewAssignment,
  );
  srv.after("SAVE", "PurchaseRequisitionReviews.drafts", (_data, req) =>
    markReviewInProgress(req),
  );
  srv.on(
    "validateReview",
    "PurchaseRequisitionReviews",
    handle(validateReview),
  );
  srv.on(
    "reviewWorkspace",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    handle(reviewWorkspace),
  );
  srv.on(
    "reviewWorkspaceV5",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    handle(reviewWorkspaceV5),
  );
  srv.on(
    "predictDraftFieldsV5",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    handle(predictDraftFieldsV5),
  );
  srv.on(
    "applyDraftSuggestionV5",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    handle(applyDraftSuggestionV5),
  );
  srv.on(
    "applyPredictionSelections",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    handle(applyPredictionSelections),
  );
  srv.on(
    "confirmDraftValueV5",
    ["PurchaseRequisitionReviews", "PurchaseRequisitionReviews.drafts"],
    handle(confirmDraftValueV5),
  );
  srv.on(
    "applyProvisionalSuggestions",
    "PurchaseRequisitionReviews.drafts",
    handle(applyProvisionalSuggestions),
  );
  srv.on(
    "predictDraftFields",
    "PurchaseRequisitionReviews.drafts",
    handle(predictDraftFields),
  );
  srv.on(
    "applyDraftSuggestion",
    "PurchaseRequisitionReviews.drafts",
    handle(applyDraftSuggestion),
  );
  srv.on(
    "confirmDraftValue",
    "PurchaseRequisitionReviews.drafts",
    handle(confirmDraftValue),
  );
  srv.on("reviewOrder", "PurchaseRequisitionReviews", handle(reviewOrder));
  srv.on(
    "submitReviewedOrder",
    "PurchaseRequisitionReviews",
    handle(submitReviewedOrder),
  );
  srv.on(
    "exportOrderDraft",
    "PurchaseRequisitionReviews",
    handle(exportOrderDraft),
  );
  srv.on(
    "submitForApproval",
    "PurchaseRequisitionReviews",
    handle(submitReview),
  );
  srv.on(
    "reconcileSource",
    "PurchaseRequisitionReviews",
    handle(reconcileReview),
  );
  srv.on(
    "confirmCurrentValues",
    "PurchaseRequisitionReviews",
    handle(confirmCurrentValues),
  );
  srv.on(
    "suggestSupplier",
    "PurchaseRequisitionReviews",
    handle((req) =>
      modelWork(async () => {
        const key = req.params[0] as Row;
        const source = await tx(async () =>
          SELECT.one.from(`${NS}.FreetextWorkItem`).where({
            PurchaseRequisition: key.PurchaseRequisition,
            PurchaseRequisitionItem: key.PurchaseRequisitionItem,
          }),
        );
        if (!source) return fail(req, 404, "Purchase requisition not found");
        requireBuyer(req, source);
        if (source.Supplier)
          return fail(
            req,
            409,
            "Supplier is already filled in the source requisition",
          );
        const labelled = labelledOf(await readItems());
        const it = (await readItems()).find(
          (x) =>
            x.PurchaseRequisition === key.PurchaseRequisition &&
            x.PurchaseRequisitionItem === key.PurchaseRequisitionItem,
        );
        if (!it) return fail(req, 404, "Model input not found");
        const results = await propose(labelled, [it], {
          fields: ["Supplier"],
          thresholds: await thresholds(),
          classify: coreClassify(meterFor(req.user)),
        });
        const p = results.get(it.id) ?? [];
        await tx(async () => {
          const current = await SELECT.one
            .from(`${NS}.FreetextWorkItem`)
            .where(key);
          if (!current || current.sourceRevision !== source.sourceRevision)
            return fail(
              req,
              409,
              "The source requisition changed while the supplier suggestion was generated",
            );
          await DELETE.from(PROPOSAL).where({ ...key, field: "Supplier" });
          if (p.length)
            await INSERT.into(PROPOSAL).entries(
              await proposalRows(it, p, similarFor(labelled, it), null),
            );
        });
        await markEnrichment(it, p);
        return SELECT.one
          .from("PurchasingDeskService.PurchaseRequisitionReviews")
          .where(key);
      }),
    ),
  );
  srv.on(
    "proposeCodes",
    handle((req) => modelWork(() => proposeCodes(req))),
  );
  srv.on("similarRequests", handle(similarRequests));
  srv.on("thresholdSimulator", handle(thresholdSimulator));
  srv.on("acceptConfidentCodes", handle(acceptConfidentCodes));
  srv.on("acceptAllConfidentCodes", handle(acceptAllConfidentCodes));
  srv.on(
    "calibrateFreetext",
    handle((req) => modelWork(() => calibrateFreetext(req))),
  );
  registerHook("freetext", "freetext.propose", onFreetext);
}
