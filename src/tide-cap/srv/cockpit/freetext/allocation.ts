import cds from "@sap/cds";
import { createHash } from "node:crypto";
import { fail } from "../kernel/errors";
import { coreClassify } from "./classify";
import { CONTEXT_ROWS, MIN_CONTEXT, itemKey } from "./domain/logic";
import { predictionInputHash, workspaceContext } from "./review";

type Row = Record<string, any>;
const { SELECT, INSERT, UPDATE, UPSERT, DELETE } = cds.ql;
const NS = "tide.cockpit";
const TARGETS = ["GLAccount", "CostCenter"] as const;
// Accounting targets stay manual unless separately authorized.
const PREDICTION_AUTHORIZED =
  process.env.TIDE_ACCOUNTING_PREDICTION === "authorized";
const UNAUTHORIZED_REASON =
  "G/L account and cost center prediction is not authorized; edit manually";
const keyOf = (row: Row) => ({
  PurchaseRequisition: row.PurchaseRequisition,
  PurchaseRequisitionItem: row.PurchaseRequisitionItem,
});
const editing = (req: cds.Request) => req.params[0]?.IsActiveEntity === false;
const entity = (name: string, draft: boolean) =>
  draft ? `PurchasingDeskService.${name}s.drafts` : `${NS}.${name}`;
const storageKey = (source: Row, review: Row, draft: boolean) => ({
  ...keyOf(source),
  ...(draft
    ? {
        DraftAdministrativeData_DraftUUID:
          review.DraftAdministrativeData_DraftUUID,
      }
    : {}),
});
const opaque = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const parse = (value: string | null) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};
const valueOf = (value: unknown, name?: string) =>
  value
    ? { kind: "code", code: String(value), displayName: name || String(value) }
    : { kind: "missing", code: null, displayName: null };
const mutable = (source: Row, review: Row) =>
  source.isOpen &&
  source.sourceRevision === review.sourceRevision &&
  !review.requiresSourceReconciliation;
const rowsOf = (source: Row, review: Row, draft: boolean) =>
  SELECT.from(entity("FreetextReviewAccountAssignment", draft)).where(
    storageKey(source, review, draft),
  );

export function allocationInputHash(review: Row, rows: Row[]) {
  const configuration = [...rows]
    .sort((first, second) =>
      String(first.PurchaseReqnAcctAssgmtNumber).localeCompare(
        String(second.PurchaseReqnAcctAssgmtNumber),
      ),
    )
    .map((row) =>
      [
        "PurchaseReqnAcctAssgmtNumber",
        "GLAccount",
        "CostCenter",
        "SalesOrder",
        "SalesOrderItem",
        "MainAsset",
        "AssetSubnumber",
        "InternalOrder",
        "WBSElement",
        "AssignedQuantity",
        "BaseUnit",
        "Currency",
        "Amount",
        "DistributionPercent",
      ].map((field) => row[field] ?? null),
    );
  return opaque([
    predictionInputHash(review),
    review.reviewedAccountAssignmentCategory,
    configuration,
  ]);
}

async function masters(review: Row, field: string) {
  if (!review.reviewedCompanyCode)
    return {
      codes: new Map<string, string>(),
      reason: "company_code_required",
    };
  if (
    !review.reviewedAccountAssignmentCategory ||
    (field === "CostCenter" && review.reviewedAccountAssignmentCategory !== "K")
  )
    return {
      codes: new Map<string, string>(),
      reason: "account_assignment_category_not_applicable",
    };
  let rows: Row[];
  if (field === "GLAccount") {
    rows = await SELECT.from("tide.s4.GLAccountCompany").where({
      CompanyCode: review.reviewedCompanyCode,
      IsBlockedForPosting: false,
    });
  } else {
    const company = await SELECT.one
      .from("tide.s4.AccountingCompanyCode")
      .where({ CompanyCode: review.reviewedCompanyCode });
    if (!company?.ControllingArea)
      return {
        codes: new Map<string, string>(),
        reason: "controlling_area_master_missing",
      };
    const date =
      review.reviewedDeliveryDate || new Date().toISOString().slice(0, 10);
    rows = await SELECT.from("tide.s4.AccountingCostCenter")
      .where`CompanyCode = ${review.reviewedCompanyCode} and ControllingArea = ${company.ControllingArea} and ValidityStartDate <= ${date} and ValidityEndDate >= ${date} and IsBlockedForPosting = false`;
  }
  const codes = new Map<string, string>(
    rows.map((row) => [
      String(row[field]),
      row[`${field}Name`] || String(row[field]),
    ]),
  );
  return {
    codes,
    reason: codes.size ? null : "accounting_master_data_missing",
  };
}

export async function allocationWorkspace(
  req: cds.Request,
  source: Row,
  review: Row,
) {
  const draft = editing(req);
  const key = storageKey(source, review, draft);
  const rows: Row[] = await rowsOf(source, review, draft);
  const inputHash = allocationInputHash(review, rows);
  const evidenceRows: Row[] = await SELECT.from(
    entity("FreetextAllocationEvidence", draft),
  ).where(key);
  const decisions: Row[] = await SELECT.from(
    entity("FreetextAllocationDecision", draft),
  ).where(key);
  const catalog = new Map(
    await Promise.all(
      TARGETS.map(
        async (field) => [field, await masters(review, field)] as const,
      ),
    ),
  );
  const fields = [];
  for (const row of rows)
    for (const field of TARGETS) {
      const allocationNumber = row.PurchaseReqnAcctAssgmtNumber;
      const scope = catalog.get(field)!;
      const evidence = evidenceRows
        .filter(
          (entry) =>
            entry.allocationNumber === allocationNumber &&
            entry.field === field,
        )
        .sort((first, second) => second.generation - first.generation)[0];
      const decision = decisions.find(
        (entry) =>
          entry.allocationNumber === allocationNumber && entry.field === field,
      );
      if (
        evidence?.status === "pending" &&
        Date.parse(evidence.deadlineAt) <= Date.now()
      ) {
        await UPDATE.entity(entity("FreetextAllocationEvidence", draft))
          .set({
            status: "failed",
            reason: "pending_deadline_exceeded",
            completedAt: new Date().toISOString(),
          })
          .where({
            ...key,
            allocationNumber,
            field,
            generation: evidence.generation,
            status: "pending",
          });
        evidence.status = "failed";
        evidence.reason = "pending_deadline_exceeded";
      }
      const accepted =
        !!decision &&
        decision.value === row[field] &&
        decision.appliedContextHash === inputHash;
      const fresh =
        evidence &&
        evidence.sourceRevision === source.sourceRevision &&
        evidence.sourceFingerprint === source.sourceFingerprint &&
        (evidence.inputHash === inputHash ||
          (accepted && decision?.evidenceGeneration === evidence.generation));
      const status = evidence
        ? fresh
          ? evidence.status
          : "stale"
        : "unavailable";
      const id = opaque([
        "allocation",
        key,
        allocationNumber,
        field,
        evidence?.generation,
        evidence?.inputHash,
        source.sourceRevision,
        source.sourceFingerprint,
      ]);
      const canUse = mutable(source, review) && !scope.reason;
      const canApply = canUse && status === "available";
      const candidates: Row[] = fresh ? parse(evidence.candidates) : [];
      const origins = parse(row.predictionOrigins);
      fields.push({
        allocationNumber,
        field,
        property: field,
        current: valueOf(row[field], scope.codes.get(row[field])),
        origin:
          accepted && decision?.appliedAt
            ? "ai"
            : origins[field]
              ? "manual"
              : row[field]
                ? "source"
                : "missing",
        cleared: origins[field] === "manual_cleared",
        reviewed: !!(accepted && decision?.confirmedAt),
        capabilities: {
          canInspect: true,
          canPredict: PREDICTION_AUTHORIZED && canUse && status !== "pending",
          canApply: draft && canApply,
          canEditToApply:
            !draft &&
            canApply &&
            ["needs_review", "source_changed"].includes(source.lifecycleStatus),
          canConfirm:
            draft && canUse && !!row[field] && scope.codes.has(row[field]),
          canRetry:
            PREDICTION_AUTHORIZED &&
            canUse &&
            ["failed", "stale", "canceled"].includes(status),
          reviewOnly: !draft,
          reason:
            scope.reason ||
            (PREDICTION_AUTHORIZED ? null : UNAUTHORIZED_REASON) ||
            evidence?.reason ||
            null,
        },
        evidence: {
          id,
          generation: evidence?.generation ?? null,
          inputHash: evidence?.inputHash ?? null,
          status,
          reason: scope.reason || evidence?.reason || null,
          candidates: (Array.isArray(candidates) ? candidates : [])
            .filter((candidate) => scope.codes.has(candidate.value))
            .map((candidate, index) => ({
              id: opaque([id, candidate.value]),
              rank: index + 1,
              value: valueOf(candidate.value, scope.codes.get(candidate.value)),
              modelScore: candidate.modelScore,
            })),
          historicalReliability: null,
          evaluationScope: null,
          sampleSize: null,
          calibrationIdentity: null,
          runIdentity: evidence?.runIdentity ?? null,
          backend: evidence?.backend ?? null,
          modelVersion: evidence?.modelVersion ?? null,
          computedAt: evidence?.computedAt ?? null,
          supportingHistory: null,
          summary: null,
          staleReasons:
            evidence && !fresh ? ["allocation_or_inputs_changed"] : [],
        },
        decision: accepted ? decision : null,
      });
    }
  return {
    allocationIdentity: {
      draftUUID: review.DraftAdministrativeData_DraftUUID ?? null,
      modifiedAt: review.modifiedAt,
      inputHash,
      sourceRevision: source.sourceRevision,
      sourceFingerprint: source.sourceFingerprint,
    },
    allocationFields: fields,
  };
}

async function checked(req: cds.Request, requireDraft = false) {
  const { source, review } = await workspaceContext(req);
  if (requireDraft && !editing(req))
    throw fail(409, "Choose Edit before changing an allocation");
  if (!mutable(source, review))
    throw fail(409, "Reconcile the current source before continuing");
  if (
    requireDraft &&
    !["needs_review", "source_changed"].includes(source.lifecycleStatus)
  )
    throw fail(409, "This requisition is locked");
  const workspace = await allocationWorkspace(req, source, review);
  const identity = workspace.allocationIdentity;
  if (
    !req.data.expectedModifiedAt ||
    !req.data.expectedInputHash ||
    (req.data.expectedDraftUUID ?? null) !== identity.draftUUID ||
    Date.parse(req.data.expectedModifiedAt) !==
      Date.parse(identity.modifiedAt) ||
    req.data.expectedInputHash !== identity.inputHash
  )
    throw fail(409, "The allocation changed; refresh its evidence");
  return { source, review, workspace };
}

export async function buildAllocationHistory(
  asOf: string,
  companyCode: string,
) {
  const [requests, originals, orders, items, assignments]: Row[][] =
    await Promise.all([
      SELECT.from("tide.s4.PurchaseReqnItem").where({
        CompanyCode: companyCode,
      }),
      SELECT.from("tide.s4.PurchaseReqnAcctAssgmt"),
      SELECT.from("tide.s4.PurchaseOrder").where`PurchaseOrderDate < ${asOf}`,
      SELECT.from("tide.s4.PurchaseOrderItem")
        .where`PurchaseRequisition is not null`,
      SELECT.from("tide.s4.PurchaseOrderAccountAssignment"),
    ]);
  const headers = new Map(orders.map((row) => [row.PurchaseOrder, row]));
  const history = [];
  // Oldest first so slice(-CONTEXT_ROWS) keeps the most recent requisitions deterministically.
  const ordered = [...requests].sort(
    (a, b) =>
      String(a.PurReqCreationDate ?? "").localeCompare(
        String(b.PurReqCreationDate ?? ""),
      ) ||
      String(a.PurchaseRequisition).localeCompare(
        String(b.PurchaseRequisition),
      ) ||
      String(a.PurchaseRequisitionItem).localeCompare(
        String(b.PurchaseRequisitionItem),
      ),
  );
  for (const request of ordered) {
    if (
      request.Material ||
      request.IsDeleted ||
      !request.PurReqCreationDate ||
      request.PurReqCreationDate >= asOf
    )
      continue;
    const sourceRows = originals.filter(
      (row) =>
        row.PurchaseRequisition === request.PurchaseRequisition &&
        row.PurchaseRequisitionItem === request.PurchaseRequisitionItem,
    );
    const linked = items.filter(
      (row) =>
        row.PurchaseRequisition === request.PurchaseRequisition &&
        row.PurchaseRequisitionItem === request.PurchaseRequisitionItem &&
        headers.has(row.PurchaseOrder) &&
        !row.PurchasingDocumentDeletionCode,
    );
    if (
      sourceRows.length !== 1 ||
      sourceRows[0].IsDeleted ||
      linked.length !== 1
    )
      continue;
    const item = linked[0];
    if (headers.get(item.PurchaseOrder)?.CompanyCode !== companyCode) continue;
    const outcomes = assignments.filter(
      (row) =>
        row.PurchaseOrder === item.PurchaseOrder &&
        row.PurchaseOrderItem === item.PurchaseOrderItem &&
        !row.IsDeleted,
    );
    if (outcomes.length !== 1) continue;
    const original = sourceRows[0];
    const outcome = outcomes[0];
    history.push({
      id: `H/${item.PurchaseOrder}/${item.PurchaseOrderItem}/${outcome.AccountAssignmentNumber}`,
      PurchaseRequisition: request.PurchaseRequisition,
      PurchaseRequisitionItem: request.PurchaseRequisitionItem,
      text: request.PurchaseRequisitionItemText,
      Plant: request.Plant,
      CompanyCode: request.CompanyCode,
      PurchasingOrganization: request.PurchasingOrganization,
      AccountAssignmentCategory: request.AccountAssignmentCategory,
      RequestedQuantity: request.RequestedQuantity,
      BaseUnit: request.BaseUnit,
      AllocationCount: 1,
      AssignedQuantity: original.Quantity ?? null,
      DistributionPercent: original.DistributionPercent ?? null,
      sourceGLAccount: original.GLAccount ?? null,
      sourceCostCenter: original.CostCenter ?? null,
      GLAccount: outcome.GLAccount || null,
      CostCenter: outcome.CostCenter || null,
    });
  }
  return history;
}

async function publish(job: Row, patch: Row, target?: Row) {
  await UPDATE.entity(entity("FreetextAllocationEvidence", job.draft))
    .set(patch)
    .where({
      ...job.key,
      generation: job.generation,
      inputHash: job.inputHash,
      status: "pending",
      ...(target
        ? { allocationNumber: target.allocationNumber, field: target.field }
        : {}),
    });
}

async function runPrediction(user: cds.User, job: Row) {
  const queryIDs: string[] = [];
  const req = Object.assign(
    new cds.Request({ event: "predictAllocation", data: {} }),
    {
      user,
      params: [{ ...keyOf(job.source), IsActiveEntity: !job.draft }],
    },
  );
  const current = async () => {
    const context = await workspaceContext(req);
    const rows: Row[] = await rowsOf(context.source, context.review, job.draft);
    if (
      !mutable(context.source, context.review) ||
      context.review.allocationPredictionGeneration !== job.generation ||
      context.source.sourceFingerprint !== job.source.sourceFingerprint ||
      context.source.sourceRevision !== job.source.sourceRevision ||
      allocationInputHash(context.review, rows) !== job.inputHash
    )
      throw fail(409, "allocation_or_source_changed");
    return { ...context, rows };
  };
  try {
    const snapshot = await current();
    const dataset = await SELECT.one
      .from("tide.s4.DatasetInfo")
      .where({ ID: "current" });
    // No snapshot as-of means no leakage-safe cutoff; today would admit future outcomes.
    if (!dataset?.asOf) throw fail(409, "dataset_as_of_missing");
    const asOf = String(dataset.asOf).slice(0, 10);
    const history = await buildAllocationHistory(
      asOf,
      snapshot.review.reviewedCompanyCode,
    );
    const originals: Row[] = await SELECT.from(
      `${NS}.FreetextWorkItemAccountAssignment`,
    ).where(keyOf(job.source));
    for (const target of job.targets) {
      await current();
      const field = TARGETS.find((field) => field === target.field);
      if (!field) throw fail(400, "unknown_allocation_prediction_field");
      const row = snapshot.rows.find(
        (row) => row.PurchaseReqnAcctAssgmtNumber === target.allocationNumber,
      );
      if (!row) throw fail(409, "allocation_or_source_changed");
      const original =
        originals.find(
          (row) => row.PurchaseReqnAcctAssgmtNumber === target.allocationNumber,
        ) || {};
      const scope = await masters(snapshot.review, target.field);
      if (scope.reason) {
        await publish(
          job,
          {
            status: "unavailable",
            reason: scope.reason,
            completedAt: new Date().toISOString(),
          },
          target,
        );
        continue;
      }
      const train = history
        .filter(
          (row) =>
            row[field] &&
            (field !== "CostCenter" || row.AccountAssignmentCategory === "K"),
        )
        .slice(-CONTEXT_ROWS);
      if (
        train.length < MIN_CONTEXT ||
        new Set(train.map((row) => row[field])).size < 2
      ) {
        await publish(
          job,
          {
            status: "unavailable",
            reason: "insufficient_unambiguous_history",
            completedAt: new Date().toISOString(),
          },
          target,
        );
        continue;
      }
      const id = `Q/${cds.utils.uuid()}`;
      queryIDs.push(id);
      const query = {
        id,
        PurchaseRequisition: "Q",
        PurchaseRequisitionItem: id.slice(2, 7),
        text: snapshot.review.reviewedShortText,
        Plant: snapshot.review.reviewedPlant,
        CompanyCode: snapshot.review.reviewedCompanyCode,
        PurchasingOrganization: snapshot.review.reviewedPurchasingOrganization,
        AccountAssignmentCategory:
          snapshot.review.reviewedAccountAssignmentCategory,
        RequestedQuantity: snapshot.review.reviewedQuantity,
        BaseUnit: snapshot.review.reviewedUnit,
        AllocationCount: snapshot.rows.length,
        AssignedQuantity: row.AssignedQuantity,
        DistributionPercent: row.DistributionPercent,
        sourceGLAccount: original.GLAccount || null,
        sourceCostCenter: original.CostCenter || null,
        GLAccount: null,
        CostCenter: null,
      };
      await UPSERT.into(`${NS}.FreetextAllocationItem`).entries([
        ...train,
        query,
      ]);
      const meter = {
        user,
        calls: 0,
        cost: 0,
        runs: [],
        planned: [],
        backend: null,
        failed: [],
      };
      const columns = [
        "text",
        "Plant",
        "CompanyCode",
        "PurchasingOrganization",
        "AccountAssignmentCategory",
        "RequestedQuantity",
        "BaseUnit",
        "AllocationCount",
        "AssignedQuantity",
        "DistributionPercent",
        "sourceGLAccount",
        "sourceCostCenter",
      ].map((name) => ({
        name,
        kind: (name === "text"
          ? "text"
          : [
                "RequestedQuantity",
                "AllocationCount",
                "AssignedQuantity",
                "DistributionPercent",
              ].includes(name)
            ? "numeric"
            : "categorical") as "text" | "numeric" | "categorical",
      }));
      const result = await coreClassify(
        meter,
        "CockpitAllocationFeed",
      )({
        field: target.field,
        label: `Allocation ${target.allocationNumber} ${target.field}`,
        columns,
        train,
        test: [query],
        deadlineMs: 120_000,
      });
      const scores = result.probabilities.get(itemKey(query));
      const candidates = result.classes
        .map((value, index) => ({ value, modelScore: scores?.[index] }))
        .filter(
          (candidate) =>
            scope.codes.has(candidate.value) &&
            typeof candidate.modelScore === "number" &&
            Number.isFinite(candidate.modelScore) &&
            candidate.modelScore >= 0 &&
            candidate.modelScore <= 1,
        )
        .sort(
          (first, second) =>
            second.modelScore! - first.modelScore! ||
            first.value.localeCompare(second.value),
        );
      await current();
      await publish(
        job,
        {
          status: candidates.length ? "available" : "unavailable",
          reason: candidates.length ? null : "no_valid_candidates",
          candidates: JSON.stringify(candidates),
          backend: result.backend ?? null,
          modelVersion: result.modelVersion ?? null,
          runIdentity: meter.runs.join(",").slice(0, 120),
          computedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
        target,
      );
    }
  } catch (error: any) {
    await publish(job, {
      status: [404, 409].includes(error.status) ? "stale" : "failed",
      reason: String(error.message || error).slice(0, 200),
      completedAt: new Date().toISOString(),
    });
  } finally {
    if (queryIDs.length)
      await DELETE.from(`${NS}.FreetextAllocationItem`)
        .where`id in ${queryIDs}`;
  }
}

export async function predictAllocationFieldsV5(req: cds.Request) {
  if (!PREDICTION_AUTHORIZED) throw fail(403, UNAUTHORIZED_REASON);
  const { source, review, workspace } = await checked(req);
  const targets = req.data.selectedTargets;
  if (
    !Array.isArray(targets) ||
    !targets.length ||
    new Set(
      targets.map((target) => `${target.allocationNumber}/${target.field}`),
    ).size !== targets.length
  )
    throw fail(400, "Choose distinct allocation targets");
  for (const target of targets) {
    if (!TARGETS.includes(target.field))
      throw fail(400, "Unsupported allocation target");
    if (
      !workspace.allocationFields.find(
        (field) =>
          field.allocationNumber === target.allocationNumber &&
          field.field === target.field,
      )?.capabilities.canPredict
    )
      throw fail(
        409,
        "Allocation prediction is unavailable; inspect its prerequisite",
      );
  }
  const draft = editing(req);
  const key = storageKey(source, review, draft);
  const generation = Number(review.allocationPredictionGeneration || 0) + 1;
  const claimed = await UPDATE.entity(
    draft
      ? "PurchasingDeskService.PurchaseRequisitionReviews.drafts"
      : `${NS}.FreetextReview`,
  )
    .set({
      allocationPredictionGeneration: generation,
      ...(draft
        ? {}
        : { modifiedAt: review.modifiedAt, modifiedBy: review.modifiedBy }),
    })
    .where({
      ...key,
      modifiedAt: review.modifiedAt,
      allocationPredictionGeneration:
        review.allocationPredictionGeneration || 0,
    });
  if (Number(claimed) !== 1)
    throw fail(409, "Another allocation operation already started");
  const requestedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 120_000).toISOString();
  await UPDATE.entity(entity("FreetextAllocationEvidence", draft))
    .set({
      status: "canceled",
      reason: "superseded_by_refresh",
      completedAt: requestedAt,
    })
    .where({ ...key, status: "pending" });
  await INSERT.into(entity("FreetextAllocationEvidence", draft)).entries(
    targets.map((target) => ({
      ...key,
      ...target,
      generation,
      inputHash: workspace.allocationIdentity.inputHash,
      sourceRevision: source.sourceRevision,
      sourceFingerprint: source.sourceFingerprint,
      status: "pending",
      requestedAt,
      deadlineAt,
    })),
  );
  const job = {
    source,
    review,
    key,
    draft,
    generation,
    inputHash: workspace.allocationIdentity.inputHash,
    targets,
  };
  const user = req.user;
  const tenant = cds.context?.tenant;
  const launch = () =>
    (cds as any)._with(new (cds.EventContext as any)({ user, tenant }), () =>
      runPrediction(user, job).catch(() => undefined),
    );
  if (typeof (req as any).on === "function") req.on("succeeded", launch);
  else setTimeout(launch, 0).unref?.();
  return {
    generation,
    inputHash: job.inputHash,
    deadlineAt,
    outcomes: targets.map((target) => ({ ...target, status: "pending" })),
  };
}

export async function applyAllocationSelectionsV5(req: cds.Request) {
  const { source, review, workspace } = await checked(req, true);
  const selections = req.data.selections;
  if (
    !Array.isArray(selections) ||
    !selections.length ||
    new Set(
      selections.map(
        (selection) => `${selection.allocationNumber}/${selection.field}`,
      ),
    ).size !== selections.length
  )
    throw fail(400, "Choose distinct allocation values");
  const chosen = selections.map((selection) => {
    const field = workspace.allocationFields.find(
      (field) =>
        field.allocationNumber === selection.allocationNumber &&
        field.field === selection.field,
    );
    const candidate = field?.evidence.candidates.find(
      (candidate) => candidate.id === selection.candidateID,
    );
    if (
      !field?.capabilities.canApply ||
      field.evidence.id !== selection.evidenceID ||
      !candidate ||
      field.current.kind !== selection.expectedValue?.kind ||
      field.current.code !== selection.expectedValue?.code
    )
      throw fail(409, "The selected allocation value or evidence changed");
    return { field, candidate };
  });
  const key = storageKey(source, review, true);
  const now = new Date().toISOString();
  const claimed = await UPDATE.entity(
    "PurchasingDeskService.PurchaseRequisitionReviews.drafts",
  )
    .set({ modifiedAt: now })
    .where({ ...key, modifiedAt: review.modifiedAt });
  if (Number(claimed) !== 1) throw fail(409, "The editing draft changed");
  for (const { field, candidate } of chosen) {
    const row = await SELECT.one
      .from(entity("FreetextReviewAccountAssignment", true))
      .where({ ...key, PurchaseReqnAcctAssgmtNumber: field.allocationNumber });
    const updated = await UPDATE.entity(
      entity("FreetextReviewAccountAssignment", true),
    )
      .set({
        [field.field]: candidate.value.code,
        predictionOrigins: JSON.stringify({
          ...parse(row.predictionOrigins),
          [field.field]: "ai",
        }),
      })
      .where({
        ...key,
        PurchaseReqnAcctAssgmtNumber: field.allocationNumber,
        [field.field]: row[field.field] ?? null,
      });
    if (Number(updated) !== 1) throw fail(409, "The allocation changed");
  }
  const inputHash = allocationInputHash(
    review,
    await rowsOf(source, review, true),
  );
  for (const { field, candidate } of chosen)
    await UPSERT.into(entity("FreetextAllocationDecision", true)).entries({
      ...key,
      allocationNumber: field.allocationNumber,
      field: field.field,
      value: candidate.value.code,
      evidenceGeneration: field.evidence.generation,
      inputHash: field.evidence.inputHash,
      appliedContextHash: inputHash,
      appliedAt: now,
      confirmedAt: now,
    });
}

export async function confirmAllocationValueV5(req: cds.Request) {
  const { source, review, workspace } = await checked(req, true);
  const field = workspace.allocationFields.find(
    (field) =>
      field.allocationNumber === req.data.allocationNumber &&
      field.field === req.data.field,
  );
  if (
    !field?.capabilities.canConfirm ||
    field.current.kind !== req.data.expectedValue?.kind ||
    field.current.code !== req.data.expectedValue?.code
  )
    throw fail(
      409,
      "The allocation value changed or is not valid in this scope",
    );
  const key = {
    ...storageKey(source, review, true),
    allocationNumber: field.allocationNumber,
    field: field.field,
  };
  const confirmedAt = new Date().toISOString();
  const claimed = await UPDATE.entity(
    "PurchasingDeskService.PurchaseRequisitionReviews.drafts",
  )
    .set({ modifiedAt: confirmedAt })
    .where({
      ...storageKey(source, review, true),
      modifiedAt: review.modifiedAt,
    });
  if (Number(claimed) !== 1) throw fail(409, "The editing draft changed");
  const existing = await SELECT.one
    .from(entity("FreetextAllocationDecision", true))
    .where(key);
  await UPSERT.into(entity("FreetextAllocationDecision", true)).entries({
    ...key,
    value: field.current.code,
    evidenceGeneration: existing?.evidenceGeneration ?? null,
    inputHash: existing?.inputHash ?? workspace.allocationIdentity.inputHash,
    appliedContextHash: workspace.allocationIdentity.inputHash,
    appliedAt: existing?.appliedAt ?? null,
    confirmedAt,
  });
}

export async function recordManualAllocationChange(
  req: cds.Request,
  source: Row,
  review: Row,
) {
  if (["SAVE", "draftActivate", "draftPrepare"].includes((req as any)._.event))
    return;
  if ("predictionOrigins" in req.data)
    throw fail(400, "Allocation provenance is read-only");
  const fields = TARGETS.filter((field) => field in req.data);
  if (!fields.length) return;
  const draft = req.target?.name.endsWith(".drafts") || editing(req);
  const key = storageKey(source, review, draft);
  const allocationNumber =
    req.data.PurchaseReqnAcctAssgmtNumber ||
    req.params.find((param) => param.PurchaseReqnAcctAssgmtNumber)
      ?.PurchaseReqnAcctAssgmtNumber;
  if (!allocationNumber) throw fail(400, "An allocation number is required");
  const row = await SELECT.one
    .from(entity("FreetextReviewAccountAssignment", draft))
    .where({ ...key, PurchaseReqnAcctAssgmtNumber: allocationNumber });
  const origins = parse(row?.predictionOrigins);
  for (const field of fields) {
    origins[field] = req.data[field] ? "manual" : "manual_cleared";
    await DELETE.from(entity("FreetextAllocationDecision", draft)).where({
      ...key,
      allocationNumber,
      field,
    });
  }
  req.data.predictionOrigins = JSON.stringify(origins);
}

export async function validateAllocationDecisions(source: Row, review: Row) {
  const rows: Row[] = await rowsOf(source, review, false);
  const inputHash = allocationInputHash(review, rows);
  const decisions: Row[] = await SELECT.from(
    entity("FreetextAllocationDecision", false),
  ).where(keyOf(source));
  for (const decision of decisions) {
    const row = rows.find(
      (row) => row.PurchaseReqnAcctAssgmtNumber === decision.allocationNumber,
    );
    const scope = await masters(review, decision.field);
    if (
      !row ||
      row[decision.field] !== decision.value ||
      decision.appliedContextHash !== inputHash ||
      !decision.confirmedAt ||
      !scope.codes.has(decision.value)
    )
      throw fail(
        400,
        `Allocation ${decision.allocationNumber} ${decision.field} requires current buyer confirmation and valid master data`,
      );
  }
}

export async function cancelSavedAllocationPredictions(source: Row) {
  await UPDATE.entity(entity("FreetextAllocationEvidence", false))
    .set({
      status: "canceled",
      reason: "draft_saved",
      completedAt: new Date().toISOString(),
    })
    .where({ ...keyOf(source), status: "pending" });
}
