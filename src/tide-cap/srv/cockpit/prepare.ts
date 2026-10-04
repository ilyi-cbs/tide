// prepareDay: builds the cockpit's read model for the dataset's as-of date.
//
// 1. ItemFact <- ItemFactSource (one INSERT ... SELECT in the database).
// 2. Lead-time history per source (material x supplier x plant): receipts
//    before the as-of date (./prepare/histories.ts).
// 3. Ranges for every source with an open item or an info record
//    (./prepare/ranges.ts):
//    - TabPFN is always called (one quantile run per plant, all sources of
//      the plant at once), features known at PO creation;
//    - the own-history (empirical) range is additionally computed whenever
//      the source has >= EMPIRICAL_MIN own lead times, as secondary evidence
//      alongside the AI estimate (agreement between the two is reported).
// 4. Open items: expected availability p10..p90, status, customer impact
//    (./prepare/open-items.ts, ./prepare/lookups.ts).
// 5. Source findings: planned delivery time rule / range check, proposal,
//    backtest; tier 1 behind open items, tier 2 without
//    (./prepare/source-findings.ts). Customer risk in ./prepare/customer-risk.ts.
// 6. Proof on a cutoff before the as-of date (./proof.ts).
//
// This file only orchestrates startPrepareDay/prepareDay (the detached job)
// and recomputeItem (the single-item path reusing the same steps 3-5).
import cds from "@sap/cds";
import { proof } from "./proof";
import { AppError, ERROR_MESSAGES, type ErrorCode } from "../core/errors";
import { fail } from "./kernel/errors";
import {
  FEATURES,
  FEED,
  NS,
  awaitRun,
  callCore,
  estimate,
  inTx,
  meterRun,
  runResults,
  type Meter,
  type Row,
  withPredictionOptions,
} from "./kernel/model-calls";
import { runSteps, steps } from "./kernel/steps";
import { adoptStoredPredictions } from "../core/stored-predictions";
import type { StepContext } from "./kernel/types";
import {
  assertPublicationFence,
  observePublication,
  PREPARATION_POLICY,
  sourceIdentity,
  workflowFence,
  writePreparation,
} from "./kernel/publication";
import {
  assessPrevention,
  latestAssessment,
} from "./kernel/prevention-assessment";
import { chunks, insertAll, key, type SourceKey } from "./prepare/shared";
import { histories, type Source } from "./prepare/histories";
import {
  empiricalRange,
  plantContextFingerprint,
  ranges,
  rangeRecord,
  tabpfnRanges,
  type RangeRow,
} from "./prepare/ranges";
import { rangeSpec, representativeItems } from "./kernel/source-ranges";
import {
  demand,
  names,
  rates,
  type Demand,
  type Names,
} from "./prepare/lookups";
import {
  buildItem,
  byPriority,
  effectivePdt,
  openItems,
  promisedFor,
} from "./prepare/open-items";
import {
  poActivity,
  rerankFindings,
  sourceFindings,
} from "./prepare/source-findings";
import { customerRisks } from "./prepare/customer-risk";
import { sumRevenue } from "./impact/domain/impact";

// Model calls live in kernel/model-calls.ts (contract A1); re-exported for legacy importers.
export {
  FEATURES,
  FEED,
  NS,
  awaitRun,
  callCore,
  estimate,
  meterRun,
  runResults,
};
export type { Meter, Row };
export type { SourceKey, RangeRow };

const { SELECT, INSERT, DELETE, UPDATE, UPSERT } = cds.ql;
const LOG = cds.log("cockpit");

/** Snapshot message prefix of dry runs; kpis() skips these snapshots. */
export const DRY_RUN = "dry run";

export async function datasetInfo() {
  return SELECT.one.from("tide.s4.DatasetInfo").where({ ID: "current" });
}

/** Step 1: materialize the per-item facts in the database. */
export async function materializeFacts() {
  const db = await cds.connect.to("db");
  await DELETE.from(`${NS}.ItemFact`);
  const cols = Object.keys(
    (cds.model as any).definitions[`${NS}.ItemFact`].elements,
  );
  await db.run(
    INSERT.into(`${NS}.ItemFact`)
      .columns(cols)
      .from(SELECT.from(`${NS}.ItemFactSource`).columns(cols)),
  );
}

/** A running snapshot younger than this blocks a new preparation; older ones count as abandoned. */
const RUNNING_WINDOW_MS = 60 * 60_000;

/**
 * Reuse the completed read model for this exact loaded dataset. Dry runs are
 * kept only as diagnostics and must never satisfy the real preparation cache.
 */
async function reusableSnapshot(info: {
  asOf: string;
  loadId?: string | null;
}) {
  const snapshots: Row[] = await SELECT.from(`${NS}.Snapshot`)
    .where({ asOf: info.asOf })
    .orderBy("finishedAt desc");
  const sameLoad = snapshots.filter(
    (s) => (s.loadId ?? null) === (info.loadId ?? null),
  );
  const done = sameLoad.find(
    (s) =>
      s.status === "done" &&
      s.publishedAt &&
      s.policyVersion === PREPARATION_POLICY &&
      !String(s.message ?? "").startsWith(DRY_RUN),
  );
  if (done) return done;

  const since = Date.now() - RUNNING_WINDOW_MS;
  return sameLoad.find(
    (s) =>
      s.status === "running" &&
      Date.parse(s.startedAt) > since &&
      !String(s.message ?? "").startsWith(DRY_RUN),
  );
}

/** The newest real snapshot, regardless of dataset, while preserving dry-run history. */
export async function latestRealSnapshot(info?: {
  asOf?: string;
  loadId?: string | null;
}) {
  const published = await SELECT.one
    .from(`${NS}.PublishedCockpit`)
    .where({ ID: "current" });
  if (published?.snapshot_ID) {
    const snapshot = await SELECT.one
      .from(`${NS}.Snapshot`)
      .where({ ID: published.snapshot_ID, status: "done" });
    if (snapshot && (!info?.asOf || snapshot.asOf <= info.asOf))
      return snapshot;
  }
  const query = SELECT.from(`${NS}.Snapshot`).where({ status: "done" });
  if (info?.asOf)
    query.where({ loadId: info.loadId ?? null }).and`asOf <= ${info.asOf}`;
  const snapshots: Row[] = await query.orderBy("finishedAt desc");
  return snapshots.find((s) => !String(s.message ?? "").startsWith(DRY_RUN));
}

/**
 * Starts a day preparation. It runs detached from the calling request: its
 * queries use short transactions of their own (SQLite has one connection, and
 * the TabPFN runs it waits for must be committed to the queue first).
 * Returns a matching completed/in-progress snapshot if this exact dataset has
 * already been prepared; otherwise returns the new snapshot in status
 * `running` and clients poll it.
 *
 * Runs once: the snapshot row is the marker. It is inserted in one statement
 * only if no `running` snapshot younger than RUNNING_WINDOW_MS exists, in a
 * transaction (the request's, or a root one outside requests). On databases where two such inserts could still
 * both pass (no serializable isolation), the post-check keeps the oldest
 * running snapshot and fails the others, so exactly one job starts.
 */
export async function startPrepareDay(
  user: cds.User,
  dryRun = false,
  force = false,
  request?: cds.Request,
) {
  const info = await datasetInfo();
  if (!info?.asOf)
    throw fail(409, "No dataset is loaded (run the loader first)");
  if (!dryRun && !force) {
    const reusable = await reusableSnapshot(info);
    if (reusable) return reusable;
  }
  const snapshot = {
    ID: cds.utils.uuid(),
    asOf: info.asOf,
    datasetName: info.name,
    loadId: info.loadId,
    status: "running",
    startedAt: new Date().toISOString(),
    message: dryRun ? DRY_RUN : null,
  };
  const since = new Date(Date.now() - RUNNING_WINDOW_MS).toISOString();
  const claimed = await inTx(async () => {
    const db = await cds.connect.to("db");
    await db.run(
      `INSERT INTO tide_cockpit_Snapshot (ID, asOf, datasetName, loadId, status, startedAt, message)
       SELECT ?, ?, ?, ?, 'running', ?, ? FROM tide_s4_DatasetInfo
       WHERE ID = 'current' AND NOT EXISTS
         (SELECT 1 FROM tide_cockpit_Snapshot WHERE status = 'running' AND startedAt > ?)`,
      [
        snapshot.ID,
        snapshot.asOf,
        snapshot.datasetName,
        snapshot.loadId,
        snapshot.startedAt,
        snapshot.message,
        since,
      ],
    );
    const first = await SELECT.one
      .from(`${NS}.Snapshot`)
      .columns("ID", "asOf", "loadId", "message")
      .where`status = 'running' and startedAt > ${since}`.orderBy(
      "startedAt",
      "ID",
    );
    if (first?.ID === snapshot.ID) return snapshot;
    if (
      first?.asOf === info.asOf &&
      (first?.loadId ?? null) === (info.loadId ?? null) &&
      (dryRun || !String(first?.message ?? "").startsWith(DRY_RUN))
    )
      return first;
    await UPDATE.entity(`${NS}.Snapshot`)
      .where({ ID: snapshot.ID, status: "running" })
      .with({
        status: "failed",
        finishedAt: new Date().toISOString(),
        message: "Another day is already being prepared.",
      });
    return null;
  });
  if (!claimed) throw fail(409, "The day is already being prepared");
  // Another request or server instance won the conditional insert for this
  // same dataset. Reuse its running snapshot rather than starting duplicate work.
  if (claimed.ID !== snapshot.ID) return claimed;
  // Start only after the request commits. A detached context deliberately has
  // no job-wide transaction: model waits must leave SQLite's writer free.
  const ctx = new (cds.EventContext as any)({
    user,
    tenant: cds.context?.tenant,
  });
  const launch = () => {
    (cds as any)._with(ctx, () =>
      prepareDay(user, snapshot.ID, info.asOf, dryRun).catch(() => undefined),
    );
  };
  if (request) request.on("succeeded", launch);
  else setTimeout(launch, 0).unref?.();
  return snapshot;
}

/** Ensure the loaded dataset has a real prepared snapshot; safe to call at startup. */
export async function ensurePreparedDataset(
  user: cds.User = cds.User.privileged,
) {
  const info = await datasetInfo();
  if (!info?.asOf) {
    LOG.info("prepareDay startup check skipped: no dataset is loaded");
    return null;
  }
  // At startup no job of this process runs yet; a running snapshot was left by a stopped server.
  const abandoned = await cds.tx(() =>
    UPDATE.entity(`${NS}.Snapshot`).where({ status: "running" }).with({
      status: "failed",
      finishedAt: new Date().toISOString(),
      message: "Abandoned: the server stopped during preparation.",
    }),
  );
  if (Number(abandoned))
    LOG.warn(
      `prepareDay: marked ${abandoned} abandoned running snapshot(s) failed`,
    );
  if (/^(1|true)$/i.test(process.env.TIDE_RECOMPUTE ?? ""))
    return withPredictionOptions(true, () =>
      startPrepareDay(user, false, true),
    );
  await adoptStoredPredictions();
  return startPrepareDay(user, false);
}

/**
 * Claims the snapshot for this job: true only if it is still `running`
 * (checked and touched in one conditional UPDATE after the insert commits).
 */
async function claim(snapshotId: string): Promise<string | null> {
  const workerToken = cds.utils.uuid();
  const n = await cds.tx(() =>
    UPDATE.entity(`${NS}.Snapshot`)
      .where({ ID: snapshotId, status: "running", workerToken: null })
      .with({ workerToken }),
  );
  return Number(n) > 0 ? workerToken : null;
}

export async function prepareDay(
  user: cds.User,
  snapshotId: string,
  asOf: string,
  dryRun = false,
) {
  const meter: Meter = {
    user,
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  };
  const workerToken = await claim(snapshotId);
  if (!workerToken) {
    LOG.warn(
      `prepareDay: snapshot ${snapshotId} is not running any more, job skipped`,
    );
    return SELECT.one.from(`${NS}.Snapshot`).where({ ID: snapshotId });
  }
  try {
    const source = await cds.tx(() => sourceIdentity());
    const snapshot = await SELECT.one
      .from(`${NS}.Snapshot`)
      .where({ ID: snapshotId });
    if (
      source.asOf !== asOf ||
      (source.loadId ?? null) !== (snapshot?.loadId ?? null)
    )
      throw fail(
        409,
        "Imported source changed before preparation started; prepare again",
      );
    const [versions, previousPublication] = await cds.tx(() =>
      Promise.all([
        workflowFence(),
        SELECT.one.from(`${NS}.PublishedCockpit`).where({ ID: "current" }),
      ]),
    );
    if (!dryRun) await cds.tx(() => materializeFacts());
    const sources = await histories(asOf, undefined, dryRun);
    const [openRows, irRows, fx, nm]: [
      Row[],
      Row[],
      Map<string, number>,
      Names,
    ] = await Promise.all([
      SELECT.from(`${NS}.${dryRun ? "ItemFactSource" : "ItemFact"}`).where({
        IsOpen: true,
      }),
      SELECT.from("tide.s4.PurgInfoRecdOrgPlantData")
        .where`IsMarkedForDeletion is null or IsMarkedForDeletion = false`,
      rates(),
      names(),
    ]);
    const master: Row[] = await SELECT.from(
      "tide.s4.ProductPlantSupplyPlanning",
    ).columns(
      "Product",
      "Plant",
      "PlannedDeliveryDurationInDays",
      "MRPResponsible",
    );
    const masterByKey = new Map(
      master.map((m) => [`${m.Product}|${m.Plant}`, m]),
    );
    const needed = new Map<
      string,
      { Material: string; Supplier: string; Plant: string }
    >();
    for (const o of openRows)
      if (o.Material)
        needed.set(key(o.Material, o.Supplier, o.Plant), {
          Material: o.Material,
          Supplier: o.Supplier,
          Plant: o.Plant,
        });
    for (const r of irRows)
      if (r.Material && r.Supplier)
        needed.set(key(r.Material, r.Supplier, r.Plant), {
          Material: r.Material,
          Supplier: r.Supplier,
          Plant: r.Plant,
        });
    const rangeMap = await ranges(
      sources,
      [...needed.values()],
      asOf,
      dryRun,
      meter,
    );
    if (dryRun) {
      // Plan only: the read model (worklist, findings, proof) stays as it is.
      await proof(sources, snapshotId, asOf, true, meter);
      const stepErrors = await runSteps({
        user,
        snapshotId,
        asOf,
        dryRun: true,
        meter,
      });
      const cost = Math.round(meter.cost * 1e6) / 1e6;
      await cds.tx(() =>
        UPDATE.entity(`${NS}.Snapshot`)
          .where({ ID: snapshotId, status: "running" })
          .with({
            status: "done",
            finishedAt: new Date().toISOString(),
            backend: meter.backend,
            modelCalls: meter.calls,
            costUnits: cost,
            runs: JSON.stringify([]),
            message: (
              `${DRY_RUN}: ${meter.planned.length} predictions planned, ${meter.calls} model calls, ${cost} cost units` +
              (meter.failed.length
                ? `; not estimated: ${meter.failed.join("; ")}`
                : "") +
              (stepErrors.length
                ? `; failed steps: ${stepErrors.join("; ")}`
                : "")
            ).slice(0, 255),
          }),
      );
      return SELECT.one.from(`${NS}.Snapshot`).where({ ID: snapshotId });
    }

    const d = await demand(asOf, fx);
    const { items, impacts } = openItems(
      openRows,
      rangeMap,
      d,
      masterByKey,
      irRows,
      nm,
      asOf,
      snapshotId,
    );
    const findings = sourceFindings(
      irRows,
      masterByKey,
      sources,
      rangeMap,
      items,
      nm,
      snapshotId,
      await poActivity(asOf),
    );
    const customers = customerRisks(impacts, items, snapshotId);
    const ctx: StepContext = {
      user,
      snapshotId,
      asOf,
      dryRun,
      meter,
      publication: { writes: [], openItems: items },
    };
    await writePreparation(ctx, async () => {
      for (const e of [
        "SourceBacktest",
        "SourceFinding",
        "CustomerImpact",
        "OpenItem",
        "CustomerRisk",
      ])
        await DELETE.from(`${NS}.${e}`);
      // SourceRange is upserted, not wiped: unchanged sources (same fingerprint)
      // keep their stored grid across runs, so ranges() can detect them as
      // reused and skip the TabPFN call next time. Stale sources (no longer
      // needed) are removed separately below.
      const keep = new Set([...rangeMap.keys()]);
      const current: Row[] = await SELECT.from(`${NS}.SourceRange`).columns(
        "Material",
        "Supplier",
        "Plant",
      );
      for (const c of current) {
        const k = key(c.Material, c.Supplier, c.Plant);
        if (!keep.has(k))
          await DELETE.from(`${NS}.SourceRange`).where({
            Material: c.Material,
            Supplier: c.Supplier,
            Plant: c.Plant,
          });
      }
      for (const batch of chunks(
        [...rangeMap.values()].map((r) => rangeRecord(r, snapshotId)),
      ))
        await UPSERT.into(`${NS}.SourceRange`).entries(batch);
      await insertAll(`${NS}.OpenItem`, items);
      await insertAll(`${NS}.CustomerImpact`, impacts);
      await insertAll(`${NS}.SourceFinding`, findings.rows);
      await insertAll(`${NS}.SourceBacktest`, findings.backtests);
      await insertAll(`${NS}.CustomerRisk`, customers);
    });

    const stepErrors = await runSteps(ctx, [
      {
        name: "proof",
        required: false,
        run: async () => proof(sources, snapshotId, asOf, false, meter, ctx),
      },
      ...steps(),
    ]);
    const problems = [
      ...(meter.failed.length
        ? [`failed runs: ${meter.failed.join("; ")}`]
        : []),
      ...(stepErrors.length ? [`failed steps: ${stepErrors.join("; ")}`] : []),
    ];

    const count = (s: string) => items.filter((i) => i.status === s).length;
    const rangesReused = [...rangeMap.values()].filter((r) => r.reused).length;
    const rangesComputed = rangeMap.size - rangesReused;
    const itemsDirectLink = items.filter(
      (i) => i.impactLink === "direct",
    ).length;
    const itemsUpperBound = items.filter(
      (i) => i.impactLink === "upper_bound",
    ).length;
    const itemsWithoutLink = items.length - itemsDirectLink - itemsUpperBound;
    await cds.tx(async () => {
      const owned = await UPDATE.entity(`${NS}.Snapshot`)
        .where({ ID: snapshotId, status: "running", workerToken })
        .with({ workerToken });
      if (!Number(owned))
        throw fail(409, "Preparation ownership was lost; prepare again");
      await assertPublicationFence(source, versions);
      const pointer = await SELECT.one
        .from(`${NS}.PublishedCockpit`)
        .where({ ID: "current" });
      if (
        (pointer?.snapshot_ID ?? null) !==
        (previousPublication?.snapshot_ID ?? null)
      )
        throw fail(
          409,
          "Another preparation was published during this run; prepare again",
        );
      const newer = await SELECT.one.from(`${NS}.Snapshot`)
        .where`publishedAt is not null and asOf > ${asOf}`;
      if (newer) throw fail(409, "A newer source day is already published");
      for (const write of ctx.publication!.writes) await write();
      const publishedAt = new Date().toISOString();
      const observationType =
        source.source === "synthetic"
          ? "synthetic"
          : source.source === "extract" && meter.backend !== "fake"
            ? "operational"
            : "untrusted";
      const totals = await observePublication(
        snapshotId,
        asOf,
        publishedAt,
        observationType !== "untrusted",
      );
      await UPDATE.entity(`${NS}.PreparationPhase`)
        .where({ snapshot_ID: snapshotId, status: "staged" })
        .with({ status: "succeeded", finishedAt: publishedAt });
      await UPDATE.entity(`${NS}.Snapshot`)
        .where({ ID: snapshotId, status: "running", workerToken })
        .with({
          status: "done",
          finishedAt: publishedAt,
          publishedAt,
          sourceLoadedAt: source.loadedAt,
          source: source.source,
          policyVersion: PREPARATION_POLICY,
          observationType,
          completeness:
            problems.length ||
            totals.unvaluedDemands ||
            customers.some((customer) => customer.openAmount == null)
              ? "degraded"
              : "complete",
          backend: meter.backend,
          modelCalls: meter.calls,
          costUnits: Math.round(meter.cost * 1e6) / 1e6,
          runs: JSON.stringify(meter.runs),
          message: problems.length ? problems.join("; ").slice(0, 255) : null,
          openItems: items.length,
          atRisk: count("at_risk"),
          late: count("late"),
          overdue: totals.overdue,
          revenueAtRiskP50: sumRevenue(
            customers.map((customer) => customer.revenueAtRiskP50),
          ),
          revenueAtRiskP80: sumRevenue(
            customers.map((customer) => customer.revenueAtRiskP80),
          ),
          sourcesToFix: findings.rows.length,
          currency: "EUR",
          rangesReused,
          rangesComputed,
          itemsDirectLink,
          itemsUpperBound,
          itemsWithoutLink,
        });
      await UPSERT.into(`${NS}.PublishedCockpit`).entries({
        ID: "current",
        snapshot_ID: snapshotId,
        publishedAt,
      });
    });
  } catch (error: any) {
    LOG.error("prepareDay failed", error);
    await cds.tx(() =>
      UPDATE.entity(`${NS}.Snapshot`)
        .where({ ID: snapshotId, status: "running", workerToken })
        .with({
          status: "failed",
          finishedAt: new Date().toISOString(),
          message: String(
            error?.message ?? "The day could not be prepared.",
          ).slice(0, 255),
        }),
    );
    throw error;
  }
  if (!dryRun) await assessPublishedPrevention(user);
  return SELECT.one.from(`${NS}.Snapshot`).where({ ID: snapshotId });
}

async function assessPublishedPrevention(user: cds.User) {
  try {
    const headers: Row[] = await SELECT.from(`${NS}.Cases`)
      .columns("ID", "sourceFingerprint")
      .where({
        kind: {
          in: [
            "price",
            "duplicate",
            "unusual_setting",
            "supplier_planned_time",
            "material_planned_time",
          ],
        },
        status: "open",
        listing: "listed",
      });
    for (const header of headers) {
      try {
        const retained = await latestAssessment(
          header.ID,
          header.sourceFingerprint,
        );
        if (retained?.status !== "available")
          await assessPrevention(header.ID, user, {
            metric: "overview",
            expectedFingerprint: header.sourceFingerprint,
          });
      } catch (error: any) {
        LOG.warn(
          `Prevention assessment unavailable for ${header.ID}: ${error.message}`,
        );
      }
    }
  } catch (error) {
    LOG.warn(
      "Published preparation is available without supplementary prevention assessments",
      error,
    );
  }
}

/** Longest a synchronous recompute waits for its TabPFN run. */
export const RECOMPUTE_TIMEOUT_MS = 120_000;

/**
 * A published item is recomputed through a new fenced preparation generation;
 * the completed Snapshot and its observations remain immutable. Restored legacy
 * rows without publication metadata retain the compatibility path below.
 * That path refreshes the ItemFact
 * rows of its source, the source's range (empirical from own history, else
 * one TabPFN run over the plant context), then status, expected dates,
 * customer impact and worklist rank. The other open items of the same source
 * are rebuilt with the new range as well (no further model call), and the
 * source's SourceFinding (verdict, range, proposal, backtest, open risk) is
 * rewritten or removed, so the item, its source page and the worklist agree.
 * Persists items, impacts, range, finding, customer risks and snapshot
 * totals; returns the item as exposed by the service.
 *
 * Like prepareDay it uses short root transactions only and waits for the
 * run outside of them (SQLite has one connection; the queue worker needs it).
 */
export async function recomputeItem(
  user: cds.User,
  item: { PurchaseOrder: string; PurchaseOrderItem: string },
) {
  const where = {
    PurchaseOrder: item.PurchaseOrder,
    PurchaseOrderItem: item.PurchaseOrderItem,
  };
  const [info, current, running] = await cds.tx(() =>
    Promise.all([
      datasetInfo(),
      SELECT.one.from(`${NS}.OpenItem`).where(where),
      SELECT.one.from(`${NS}.Snapshot`).where({ status: "running" }),
    ]),
  );
  if (!current) throw fail(404, "Open item not found");
  if (running && Date.now() - Date.parse(running.startedAt) < RUNNING_WINDOW_MS)
    throw fail(409, "The day is being prepared; try again when it is done");
  const published = await SELECT.one
    .from(`${NS}.Snapshot`)
    .where({ ID: current.snapshot_ID });
  if (published?.publishedAt) {
    const job = await withPredictionOptions(true, () =>
      startPrepareDay(user, false, true),
    );
    const deadline = Date.now() + RECOMPUTE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = await cds.tx(() =>
        SELECT.one.from(`${NS}.Snapshot`).where({ ID: job.ID }),
      );
      if (snapshot?.status === "failed")
        throw fail(424, snapshot.message ?? "Preparation failed");
      if (snapshot?.status === "done")
        return cds.tx(() =>
          SELECT.one.from("PurchasingDeskService.OpenItems").where(where),
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw fail(
      504,
      "Preparation is still running; inspect its snapshot before retrying",
    );
  }
  const asOf: string = info.asOf;
  const snapshotId: string = current.snapshot_ID;

  // Current facts of this item and of its source (the loader may have
  // replaced the dataset rows).
  const fact: Row | undefined = await cds.tx(async () => {
    const cols = Object.keys(
      (cds.model as any).definitions[`${NS}.ItemFact`].elements,
    );
    const fresh = await SELECT.one
      .from(`${NS}.ItemFactSource`)
      .columns(...cols)
      .where(where);
    if (!fresh) return fresh;
    const same = fresh.Material
      ? await SELECT.from(`${NS}.ItemFactSource`)
          .columns(...cols)
          .where({
            Material: fresh.Material,
            Supplier: fresh.Supplier,
            Plant: fresh.Plant,
          })
      : [fresh];
    for (const batch of chunks(same))
      await UPSERT.into(`${NS}.ItemFact`).entries(batch);
    return fresh;
  });
  if (!fact?.IsOpen)
    throw fail(
      409,
      "The item is no longer open; run prepareDay to refresh the worklist",
    );

  // Range of the item's source: TabPFN is always called; falls back to
  // empirical when the model run fails or has no answer for this source.
  const src: SourceKey = {
    Material: fact.Material,
    Supplier: fact.Supplier,
    Plant: fact.Plant,
  };
  const k = key(src.Material, src.Supplier, src.Plant);
  let range: RangeRow | undefined;
  let sources = new Map<string, Source>();
  if (src.Material) {
    sources = await cds.tx(() => histories(asOf, src));
    const reps = await cds.tx(() => representativeItems([src], asOf));
    const context = await cds.tx(() =>
      plantContextFingerprint(src.Plant, asOf),
    );
    const run: any = await callCore(user, "predict", {
      spec: rangeSpec(src.Plant, [reps.get(k)!], asOf),
    });
    const done = await awaitRun(user, run.ID, RECOMPUTE_TIMEOUT_MS);
    if (done.status !== "succeeded") {
      const code = (
        done.errorCode in ERROR_MESSAGES ? done.errorCode : "INFERENCE_FAILED"
      ) as ErrorCode;
      throw new AppError(code, `recompute ${k}: run ${run.ID} ${done.status}`);
    }
    range = (
      await cds.tx(() => tabpfnRanges(run.ID, [src], reps, sources, context))
    ).ranges.get(k);
    if (!range)
      range = empiricalRange(src, sources.get(k)?.history ?? []) ?? undefined;
  }

  await cds.tx(async () => {
    const [openRows, irRows, fx, nm, master]: [
      Row[],
      Row[],
      Map<string, number>,
      Names,
      Row | undefined,
    ] = await Promise.all([
      SELECT.from(`${NS}.ItemFact`).where({ IsOpen: true }),
      SELECT.from("tide.s4.PurgInfoRecdOrgPlantData").where(src)
        .and`IsMarkedForDeletion is null or IsMarkedForDeletion = false`,
      rates(),
      names(),
      SELECT.one
        .from("tide.s4.ProductPlantSupplyPlanning")
        .columns(
          "Product",
          "Plant",
          "PlannedDeliveryDurationInDays",
          "MRPResponsible",
        )
        .where({ Product: src.Material, Plant: src.Plant }),
    ]);
    const d = await demand(asOf, fx);
    const itemKeyOf = (i: Row) => `${i.PurchaseOrder}/${i.PurchaseOrderItem}`;
    const itemKey = itemKeyOf(fact);
    const irByKey = new Map(
      irRows.map((r) => [key(r.Material, r.Supplier, r.Plant), r]),
    );
    const masterByKey = new Map<string, Row>(
      master ? [[`${master.Product}|${master.Plant}`, master]] : [],
    );
    const demandBy = promisedFor(openRows, d);

    // The item and the other open items of its source (same range, no model call).
    const persisted: Row[] = await SELECT.from(`${NS}.OpenItem`).columns(
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Supplier",
      "Plant",
      "status",
      "revenueAtRiskP50",
      "revenueAtRiskP80",
      "delayP80Days",
      "priority",
    );
    const openByKey = new Map(openRows.map((o) => [itemKeyOf(o), o]));
    const siblings = src.Material
      ? persisted.filter(
          (i) =>
            itemKeyOf(i) !== itemKey &&
            i.Material === src.Material &&
            i.Supplier === src.Supplier &&
            i.Plant === src.Plant &&
            openByKey.has(itemKeyOf(i)),
        )
      : [];
    const rebuilt = new Map<string, Row>();
    const impacts: Row[] = [];
    for (const o of [
      fact,
      ...siblings.map((i) => openByKey.get(itemKeyOf(i))!),
    ]) {
      const built = buildItem(
        o,
        range,
        effectivePdt(o, irByKey, masterByKey),
        demandBy.get(itemKeyOf(o)) ?? { link: null, promised: [] },
        nm,
        asOf,
        snapshotId,
      );
      rebuilt.set(itemKeyOf(o), built.item);
      impacts.push(...built.impacts);
    }

    if (range)
      await UPSERT.into(`${NS}.SourceRange`).entries(
        rangeRecord(range, snapshotId),
      );
    for (const r of rebuilt.values())
      await DELETE.from(`${NS}.CustomerImpact`).where({
        PurchaseOrder: r.PurchaseOrder,
        PurchaseOrderItem: r.PurchaseOrderItem,
      });
    await insertAll(`${NS}.CustomerImpact`, impacts);

    // Worklist rank among the persisted items.
    const all = persisted.map((i) => rebuilt.get(itemKeyOf(i)) ?? i);
    const ranked = [...all].sort(byPriority);
    for (const [n, i] of ranked.entries()) {
      const k2 = {
        PurchaseOrder: i.PurchaseOrder,
        PurchaseOrderItem: i.PurchaseOrderItem,
      };
      if (rebuilt.has(itemKeyOf(i))) i.priority = n + 1;
      else if (i.priority !== n + 1)
        await UPDATE.entity(`${NS}.OpenItem`, k2).with({ priority: n + 1 });
    }
    for (const r of rebuilt.values())
      await UPDATE.entity(`${NS}.OpenItem`, {
        PurchaseOrder: r.PurchaseOrder,
        PurchaseOrderItem: r.PurchaseOrderItem,
      }).with(r);

    // The source's finding, from the same range and the rebuilt items.
    const findings = src.Material
      ? sourceFindings(
          irRows,
          masterByKey,
          sources,
          new Map(range ? [[k, range]] : []),
          [...rebuilt.values()],
          nm,
          snapshotId,
          await poActivity(asOf, src),
        )
      : { rows: [], backtests: [] };
    if (src.Material) {
      await DELETE.from(`${NS}.SourceBacktest`).where(src);
      await DELETE.from(`${NS}.SourceFinding`).where(src);
      await insertAll(`${NS}.SourceFinding`, findings.rows);
      await insertAll(`${NS}.SourceBacktest`, findings.backtests);
      await rerankFindings();
    }

    // Totals that depend on the items: customer risks and the snapshot KPIs.
    const allImpacts: Row[] = await SELECT.from(`${NS}.CustomerImpact`);
    const customers = customerRisks(allImpacts, all, snapshotId);
    await DELETE.from(`${NS}.CustomerRisk`);
    await insertAll(`${NS}.CustomerRisk`, customers);
    const count = (s: string) => all.filter((i) => i.status === s).length;
    const { n: sourcesToFix } = await SELECT.one
      .from(`${NS}.SourceFinding`)
      .columns("count(1) as n");
    await UPDATE.entity(`${NS}.Snapshot`, snapshotId).with({
      openItems: all.length,
      atRisk: count("at_risk"),
      late: count("late"),
      overdue: count("overdue"),
      revenueAtRiskP50: sumRevenue(
        customers.map((customer) => customer.revenueAtRiskP50),
      ),
      revenueAtRiskP80: sumRevenue(
        customers.map((customer) => customer.revenueAtRiskP80),
      ),
      ...(customers.some((customer) => customer.openAmount == null)
        ? { completeness: "degraded" }
        : {}),
      sourcesToFix: Number(sourcesToFix),
    });
  });
  return cds.tx(() =>
    SELECT.one.from("PurchasingDeskService.OpenItems").where(where),
  );
}
