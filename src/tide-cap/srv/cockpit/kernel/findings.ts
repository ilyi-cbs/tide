// Finding rows (contract §3): buyer words and the only writers of
// tide.cockpit.Finding. Only the owner of a list writes its rows.
import cds from "@sap/cds";
import { createHash } from "node:crypto";
import { NS, inTx } from "./model-calls";
import type { FindingList, FindingRow } from "./types";
import { findingProblemKey } from "./identity";
import { recordProblemEvent } from "./approval-audit";
import {
  isTypedCaseFinding,
  unlistAbsentTypedCases,
  upsertTypedCase,
} from "./typed-cases";
import { acceptException, resolveFromSource } from "./cases";

const { SELECT, INSERT, DELETE, UPDATE, UPSERT } = cds.ql;
const ENTITY = `${NS}.Finding`;
const CHUNK = 500;

const DETAIL_BY_LIST: Record<
  FindingList,
  [property: keyof FindingRow, entity: string] | null
> = {
  at_risk: ["atRiskDetail", `${NS}.AtRiskDetail`],
  overdue: ["overdueDetail", `${NS}.OverdueDetail`],
  price: ["priceDetail", `${NS}.PriceDetail`],
  duplicate: ["duplicateDetail", `${NS}.DuplicateDetail`],
  rare: ["rareDetail", `${NS}.RareDetail`],
  pdt: ["pdtDetail", `${NS}.PdtDetail`],
  mm_pdt: ["mmPdtDetail", `${NS}.MmPdtDetail`],
  freetext: ["freetextDetail", `${NS}.FreetextDetail`],
};

const DETAIL_KEYS = new Set(
  Object.values(DETAIL_BY_LIST).flatMap((v) => (v ? [v[0]] : [])),
);

function split(row: FindingRow): {
  header: FindingRow;
  detail: { entity: string; row: Record<string, unknown> } | null;
} {
  const detailKeys = Object.keys(row).filter(
    (key) =>
      DETAIL_KEYS.has(key as keyof FindingRow) &&
      row[key as keyof FindingRow] !== undefined,
  );
  const expected = DETAIL_BY_LIST[row.list];
  if (
    detailKeys.length > 1 ||
    (detailKeys.length === 1 && (!expected || detailKeys[0] !== expected[0]))
  )
    throw new Error(
      `Finding ${row.list} must carry only its ${expected?.[0] ?? "no"} detail`,
    );
  const header = Object.fromEntries(
    Object.entries(row).filter(
      ([key]) => !DETAIL_KEYS.has(key as keyof FindingRow),
    ),
  ) as FindingRow;
  if (!expected || !header.ID || !row[expected[0]])
    return { header, detail: null };
  const value = row[expected[0]] as unknown as Record<string, unknown>;
  return {
    header,
    detail: { entity: expected[1], row: { ...value, finding_ID: header.ID } },
  };
}

async function deleteDetails(ids: string[]) {
  if (!ids.length) return;
  for (const [, entity] of Object.values(DETAIL_BY_LIST).filter(
    Boolean,
  ) as Array<[keyof FindingRow, string]>)
    await DELETE.from(entity).where({ finding_ID: { in: ids } });
}

async function insertDetails(rows: FindingRow[]) {
  const byEntity = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const detail = split(row).detail;
    if (detail)
      (
        byEntity.get(detail.entity) ??
        byEntity.set(detail.entity, []).get(detail.entity)!
      ).push(detail.row);
  }
  for (const [entity, entries] of byEntity)
    for (let i = 0; i < entries.length; i += CHUNK)
      await INSERT.into(entity).entries(entries.slice(i, i + CHUNK));
}

export {
  sourceText,
  listText,
  listCriticality,
  statusCriticality,
  impactRank,
  impactCriticality,
  impactText,
  findingID,
} from "./case-text";
import { findingID, listCriticality, listText, sourceText, statusCriticality } from "./case-text";

function complete(row: FindingRow, snapshotId?: string | null): FindingRow {
  return {
    trigger: "morning",
    status: "open",
    ...row,
    problemKey: row.problemKey ?? findingProblemKey(row),
    ...(snapshotId !== undefined && row.snapshot_ID === undefined
      ? { snapshot_ID: snapshotId }
      : {}),
    ID: findingID(row.list, row.objectKey),
    sourceText: sourceText(row.source),
    listText: listText(row.list),
    listCriticality: listCriticality(row.list),
    statusCriticality: statusCriticality(row.status ?? "open"),
  };
}

function fingerprint(row: FindingRow): string {
  // Rank, generated text and current status are not evidence.  The remaining
  // stable business facts reopen an accepted exception when they change.
  const {
    ID: _id,
    rank: _rank,
    status: _status,
    statusCriticality: _criticality,
    snapshot_ID: _snapshot,
    listText: _listText,
    listCriticality: _listCriticality,
    sourceText: _sourceText,
    problemKey: _problemKey,
    changeAvailable: _changeAvailable,
    ...facts
  } = row;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, nested]) =>
            key !== "finding_ID" && nested !== null && nested !== undefined,
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(facts)))
    .digest("hex");
}

async function applyDispositions(rows: FindingRow[]) {
  const lists = [...new Set(rows.map((row) => row.list))];
  if (!lists.length) return rows;
  const dispositions: Array<{
    list: FindingList;
    objectKey: string;
    fingerprint: string;
    reviewOn?: string | null;
  }> = [];
  for (const list of lists)
    dispositions.push(
      ...(await SELECT.from(`${NS}.PreventionDisposition`)
        .where`list = ${list}`),
    );
  const byKey = new Map(
    dispositions.map((d) => [`${d.list}:${d.objectKey}`, d]),
  );
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((row) => {
    const disposition = byKey.get(`${row.list}:${row.objectKey}`);
    if (
      !disposition ||
      disposition.fingerprint !== fingerprint(row) ||
      (disposition.reviewOn && disposition.reviewOn <= today)
    )
      return row;
    return { ...row, status: "closed" as const };
  });
}

/**
 * Replaces all rows of `lists` by `rows` (one transaction): deletes the lists,
 * inserts the rows with ID `<list>:<objectKey>` and sourceText filled. Rows
 * of other lists are refused. Returns the written rows.
 */
export async function writeFindings(
  snapshotId: string,
  lists: FindingList[],
  rows: FindingRow[],
  options: { projectOnly?: boolean } = {},
) {
  const allowed = new Set<string>(lists);
  const bad = rows.find((r) => !allowed.has(r.list));
  if (bad)
    throw new Error(
      `writeFindings: row of list ${bad.list} not in [${lists.join(", ")}]`,
    );
  const out = (await applyDispositions(rows)).map((r) =>
    complete(r, snapshotId),
  );
  out.forEach(split);
  await inTx(async () => {
    // Typed cases are authoritative. New detector writers persist them before
    // calling this compatibility projection; legacy callers retain the former
    // dual-write behavior until they are migrated.
    if (!options.projectOnly) for (const row of out) await upsertTypedCase(row);
    const existing: Array<{ ID: string }> = [];
    for (const list of lists)
      existing.push(
        ...(await SELECT.from(ENTITY).columns("ID", "list", "problemKey")
          .where`list = ${list}`),
      );
    const current = new Map(out.map((row) => [row.ID!, row]));
    for (const old of existing as Array<{
      ID: string;
      list: FindingList;
      problemKey: string;
    }>) {
      if (current.has(old.ID) || !old.problemKey) continue;
      await UPDATE.entity(`${NS}.FindingEvidence`)
        .set({
          disposition: "not_selected",
          reason:
            "No longer selected in the current worklist; source resolution was not inferred.",
        })
        .where([
          { ref: ["problemKey"] },
          "=",
          { val: old.problemKey },
          "and",
          { ref: ["list"] },
          "=",
          { val: old.list },
          "and",
          { ref: ["disposition"] },
          "=",
          { val: "current" },
        ] as any);
      await recordProblemEvent({
        problemKey: old.problemKey,
        event: "finding_not_selected",
        findingID: old.ID,
        source: "recompute",
      });
    }
    await deleteDetails(existing.map((row) => row.ID));
    for (const list of lists) await DELETE.from(ENTITY).where`list = ${list}`;
    const headers = out.map((row) => split(row).header);
    for (let i = 0; i < headers.length; i += CHUNK)
      await INSERT.into(ENTITY).entries(headers.slice(i, i + CHUNK));
    await insertDetails(out);
    for (const row of out) {
      const problemKey = row.problemKey!;
      const evidenceFingerprint = fingerprint(row);
      if (row.list === "overdue") {
        await UPDATE.entity(`${NS}.FindingEvidence`).set({
          disposition: "superseded_by_overdue",
          reason: "The open delivery obligation passed its requested date.",
        })
          .where`problemKey = ${problemKey} and list = 'at_risk' and (disposition = 'current' or disposition = 'not_selected' or disposition = 'out_of_window')`;
      }
      await UPSERT.into(`${NS}.Problem`).entries({
        problemKey,
        type: problemKey.split(":", 1)[0],
        sourceObjectKey: problemKey.split(":").slice(1).join(":"),
        status: "open",
        sourceFingerprint: evidenceFingerprint,
      });
      await UPDATE.entity(`${NS}.FindingEvidence`)
        .set({
          disposition: "not_selected",
          reason: "Superseded by newer evidence.",
        })
        .where([
          { ref: ["problemKey"] },
          "=",
          { val: problemKey },
          "and",
          { ref: ["list"] },
          "=",
          { val: row.list },
          "and",
          { ref: ["disposition"] },
          "=",
          { val: "current" },
        ] as any);
      await UPSERT.into(`${NS}.FindingEvidence`).entries({
        problemKey,
        list: row.list,
        fingerprint: evidenceFingerprint,
        findingID: row.ID,
        snapshotID: row.snapshot_ID ?? null,
        disposition: "current",
        reason: null,
        evidence: JSON.stringify(row),
      });
    }
    if (!options.projectOnly)
      await unlistAbsentTypedCases(lists, new Set(out.map((row) => row.ID!)));
  });
  return out;
}

/** Records a durable Prevention decision against the finding evidence currently shown. */
export async function savePreventionDisposition(
  findingID: string,
  outcome: "accepted" | "keep_current" | "ignored",
  note?: string | null,
  reviewOn?: string | null,
) {
  const finding = await SELECT.one.from(ENTITY).where({ ID: findingID });
  if (!finding) throw new Error("Finding not found");
  if (
    !(["price", "duplicate", "rare", "pdt", "mm_pdt"] as string[]).includes(
      finding.list,
    )
  )
    throw new Error("Only Prevention findings can be decided");
  const detail = DETAIL_BY_LIST[finding.list as FindingList];
  if (detail)
    finding[detail[0]] = await SELECT.one
      .from(detail[1])
      .where({ finding_ID: findingID });
  const now = new Date().toISOString();
  await UPSERT.into(`${NS}.PreventionDisposition`).entries({
    list: finding.list,
    objectKey: finding.objectKey,
    fingerprint: fingerprint(finding),
    outcome,
    note: note ?? null,
    reviewOn: reviewOn ?? null,
    createdAt: now,
    createdBy: cds.context?.user?.id ?? "",
    modifiedAt: now,
    modifiedBy: cds.context?.user?.id ?? "",
  });
  await UPDATE.entity(ENTITY)
    .with({ status: "closed", statusCriticality: statusCriticality("closed") })
    .where({ ID: findingID });
  if (outcome === "accepted" && isTypedCaseFinding(finding)) {
    const typedCase = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: `${finding.list}:${finding.objectKey}` });
    if (typedCase)
      await acceptException(typedCase.ID, typedCase.sourceFingerprint, note);
  }
  return SELECT.one.from(ENTITY).where({ ID: findingID });
}

/** Inserts or replaces one finding (feed, recompute, confirmation entry). */
export async function upsertFinding(
  row: FindingRow,
  options: { projectOnly?: boolean } = {},
) {
  const out = complete(row);
  split(out);
  await inTx(async () => {
    if (!options.projectOnly) await upsertTypedCase(out);
    await deleteDetails([out.ID!]);
    await UPSERT.into(ENTITY).entries(split(out).header);
    await insertDetails([out]);
    const evidenceFingerprint = fingerprint(out);
    await UPSERT.into(`${NS}.Problem`).entries({
      problemKey: out.problemKey,
      type: out.problemKey!.split(":", 1)[0],
      sourceObjectKey: out.problemKey!.split(":").slice(1).join(":"),
      status: "open",
      sourceFingerprint: evidenceFingerprint,
    });
    await UPSERT.into(`${NS}.FindingEvidence`).entries({
      problemKey: out.problemKey,
      list: out.list,
      fingerprint: evidenceFingerprint,
      findingID: out.ID,
      snapshotID: out.snapshot_ID ?? null,
      disposition: "current",
      evidence: JSON.stringify(out),
    });
  });
  return SELECT.one.from(ENTITY).where({ ID: out.ID });
}

/**
 * Sets status 'closed' on the open findings matching `where` (field → value
 * or array of values, combined with and); returns the count.
 */
export async function closeFindings(
  where: Record<string, unknown>,
  resolution: { reason?: string; source?: string } = {},
): Promise<number> {
  const xpr: any[] = [{ ref: ["status"] }, "=", { val: "open" }];
  for (const [k, v] of Object.entries(where))
    xpr.push(
      "and",
      { ref: [k] },
      ...(Array.isArray(v)
        ? ["in", { list: v.map((val) => ({ val })) }]
        : ["=", { val: v }]),
    );
  const matching: Array<{ ID: string; problemKey: string }> = await SELECT.from(
    ENTITY,
  )
    .columns("ID", "problemKey")
    .where(xpr);
  const typedIDs = matching.map((row) =>
    row.ID.split(":", 1)[0] === "at_risk" ||
    row.ID.split(":", 1)[0] === "overdue"
      ? `delivery:${row.ID.slice(row.ID.indexOf(":") + 1)}`
      : row.ID,
  );
  for (const caseID of typedIDs) {
    const typedCase = await SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: caseID });
    if (typedCase?.status === "open") {
      await resolveFromSource(
        caseID,
        resolution.reason ?? "Current source facts confirm resolution.",
      );
    }
  }
  const n = await UPDATE.entity(ENTITY)
    .set({ status: "closed", statusCriticality: statusCriticality("closed") })
    .where(xpr);
  for (const row of matching) {
    if (!row.problemKey) continue;
    const reason =
      resolution.reason ?? "Current source facts confirm resolution.";
    await UPDATE.entity(`${NS}.FindingEvidence`)
      .set({ disposition: "resolved_from_source", reason })
      .where({ problemKey: row.problemKey, disposition: "current" });
    await UPDATE.entity(`${NS}.Problem`)
      .set({
        status: "resolved",
        resolvedAt: new Date().toISOString(),
        resolutionReason: reason,
      })
      .where({ problemKey: row.problemKey });
    await recordProblemEvent({
      problemKey: row.problemKey,
      event: "resolved_from_source",
      reason,
      findingID: row.ID,
      source: resolution.source ?? "source",
    });
  }
  return Number(n) || 0;
}

/** Updates only the retained legacy read projection after a typed lifecycle change. */
export async function closeFindingProjection(ID: string) {
  return UPDATE.entity(ENTITY)
    .set({ status: "closed", statusCriticality: statusCriticality("closed") })
    .where({ ID, status: "open" });
}
