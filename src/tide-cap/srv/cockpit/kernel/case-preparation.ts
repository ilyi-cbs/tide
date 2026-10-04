import cds from "@sap/cds";
import { isDeepStrictEqual } from "node:util";
import { deliveryReminderAction } from "../impact/reminder-action";
import { priceAction } from "../rules/price-action";
import {
  duplicateMdgAction,
  rarePlannerAction,
} from "../rules/disposition-actions";
import { pdtChangeAction } from "../leadtimes/actions";
import type { PrepareActionInput } from "./actions";
import {
  activeCaseAction,
  prepareAction,
  readAction,
  reuse409,
} from "./actions";
import { inCommandScope, inScope, scopeOf } from "./auth";
import { fail } from "./errors";
import { impactText } from "./findings";
import { NS, inTx, type Row } from "./model-calls";
import type { ActionVia } from "./types";
import { assessmentJSON, latestAssessment } from "./prevention-assessment";
import { acknowledgeSourceChange } from "./cases";
import { currentWorkflowCommand } from "./commands";

export const CASE_ENTITIES: Record<string, string> = {
  delivery: "DeliveryRisks",
  price: "PriceDeviations",
  duplicate: "DuplicateMaterials",
  unusual_setting: "UnusualSettings",
  supplier_planned_time: "SupplierPlannedTimes",
  material_planned_time: "MaterialPlannedTimes",
  requisition_review: "RequisitionReviews",
};

type Context = {
  findingID?: string;
  days?: number | null;
  responsiblePerson?: string | null;
  responsibleMessage?: string | null;
  expectedFingerprint?: string | null;
};
type Builder = (
  row: Row,
  header: Row,
  via: ActionVia,
  context: Context,
) => Promise<PrepareActionInput>;
const builders = new Map<string, Builder>();
const commands = new Map<
  string,
  (caseID: string, via: ActionVia, user: cds.User) => Promise<Row>
>();

export function registerCasePreparationCommand(
  kind: string,
  command: (caseID: string, via: ActionVia, user: cds.User) => Promise<Row>,
) {
  commands.set(kind, command);
}

export function registerCaseActionBuilder(kind: string, builder: Builder) {
  builders.set(kind, builder);
}

function adapter(row: Row, header: Row, list: string, detailName: string): Row {
  const detail = { ...row, ...JSON.parse(row.detail ?? "{}") };
  if (list === "pdt" || list === "mm_pdt") {
    detail.proposalDays ??= row.proposedDays;
    detail.masterDays ??= row.currentDays;
    detail.PurchasingInfoRecord ??= row.purchasingInfoRecord;
  }
  return {
    ID: null,
    list,
    problemKey: header.ID,
    objectKey: header.ID.slice(header.ID.indexOf(":") + 1),
    ...row,
    Material: row.Material ?? row.material,
    Plant: row.Plant ?? row.plant,
    Supplier: row.Supplier ?? row.supplier,
    itemTitle: header.title,
    issue: detail.reason ?? detail.issue ?? row.summary ?? header.title,
    source: detail.source ?? row.source ?? "rule",
    [detailName]: detail,
  };
}

registerCaseActionBuilder("delivery", (row, header, via) =>
  deliveryReminderAction(
    row,
    header,
    via,
    impactText(
      row.revenueAtRisk > 0 ? "customer_order_late" : null,
      row.revenueAtRisk,
    ),
  ),
);
registerCaseActionBuilder("price", async (row, header, via, context) => {
  const person = context.responsiblePerson?.trim();
  const message = context.responsibleMessage?.trim();
  if (!person || !message)
    throw fail(
      400,
      "Price clarification requires responsiblePerson and responsibleMessage; select the responsible person and describe the clarification needed",
    );
  const input = await priceAction(
    adapter(row, header, "price", "priceDetail"),
    via,
  );
  return {
    ...input,
    responsiblePerson: person,
    responsibleMessage: message,
    summary: message,
  };
});
registerCaseActionBuilder("duplicate", async (row, header, via) => {
  const input = await duplicateMdgAction(
    adapter(row, header, "duplicate", "duplicateDetail"),
    via,
  );
  const candidates = await cds.ql.SELECT.from(`${NS}.RuleLine`)
    .columns("label", "text", "similarityScore", "n1", "n2")
    .where({ findingID: header.ID, kind: "member" })
    .orderBy("line");
  for (const item of input.items ?? [])
    item.data = {
      ...item.data,
      candidates,
      similarityBasis:
        "Fuzzy description similarity to the reference material with matching numeric tokens; not duplicate probability",
    };
  return input;
});
registerCaseActionBuilder("unusual_setting", async (row, header, via) => {
  const input = await rarePlannerAction(
    adapter(row, header, "rare", "rareDetail"),
    via,
  );
  const pairs = await cds.ql.SELECT.from(`${NS}.RuleLine`)
    .columns("label", "text", "n1", "n2", "n3")
    .where({ findingID: header.ID, kind: "pair" })
    .orderBy("line");
  const assessment = await latestAssessment(
    header.ID,
    header.sourceFingerprint,
  );
  for (const item of input.items ?? [])
    item.data = {
      ...item.data,
      settingPairs: pairs,
      assessment: assessment ? assessmentJSON(assessment) : null,
      evidenceLimitation:
        "Peer rarity and AI disagreement are review signals, not proof of incorrect settings.",
    };
  return input;
});
registerCaseActionBuilder(
  "supplier_planned_time",
  (row, header, via, context) =>
    pdtChangeAction(
      adapter(row, header, "pdt", "pdtDetail"),
      via,
      context.days,
    ),
);
registerCaseActionBuilder("material_planned_time", (row, header, via) =>
  pdtChangeAction(adapter(row, header, "mm_pdt", "mmPdtDetail"), via),
);

/** Shared command; route guards remain responsible for route-level authorization. */
export async function prepareCaseAction(
  caseID: string,
  via: ActionVia,
  user: cds.User,
  context: Context = {},
) {
  return inTx(async () => {
    const header = await cds.ql.SELECT.one
      .from(`${NS}.Cases`)
      .where({ ID: caseID });
    if (
      !header ||
      !(currentWorkflowCommand()
        ? inCommandScope(user, header)
        : inScope(scopeOf(user), header))
    )
      throw fail(404, "Case not found");
    if (header.kind === "supplier_planned_time" && !currentWorkflowCommand())
      throw fail(
        410,
        "Supplier preparation requires WorkflowService.prepareSupplierPlannedTimeAction with commandID, expectedModifiedAt and expectedFingerprint",
      );
    if (header.status !== "open") throw fail(409, "Case is closed");
    if (
      context.expectedFingerprint &&
      context.expectedFingerprint !== header.sourceFingerprint
    )
      throw fail(
        409,
        "Case evidence has changed; reload before preparing an action",
      );
    const command = commands.get(header.kind);
    if (command) return command(caseID, via, user);
    const builder = builders.get(header.kind);
    if (!builder)
      throw fail(
        501,
        `Case kind ${header.kind} is not available for preparation`,
      );
    const row = await cds.ql.SELECT.one
      .from(`${NS}.${CASE_ENTITIES[header.kind]}`)
      .where({ header_ID: caseID });
    if (!row) throw fail(404, "Typed case detail not found");
    const assessment = await latestAssessment(caseID, header.sourceFingerprint);
    if (assessment && !context.expectedFingerprint)
      throw fail(
        400,
        "expectedFingerprint is required when preparing assessed evidence",
      );
    if (
      assessment?.status === "available" &&
      ["supplier_planned_time", "material_planned_time"].includes(header.kind)
    ) {
      const metrics = JSON.parse(assessment.metrics);
      const detail = JSON.parse(row.detail ?? "{}");
      if (
        header.kind === "supplier_planned_time" &&
        metrics.some((metric: Row) => metric.detail?.recheck)
      )
        detail.settingRecheck =
          "Independent model recheck; no proposal policy change";
      if (header.kind === "material_planned_time") {
        const comparison = metrics.find(
          (metric: Row) =>
            metric.label === "Order-share weighted supplier model medians",
        )?.detail;
        if (comparison?.trigger) detail.settingComparison = comparison;
      }
      row.detail = JSON.stringify(detail);
    }
    const input = await builder(row, header, via, context);
    input.cases = [
      { ID: caseID, operation: input.operationKey!, role: "primary" },
    ];
    input.problemKey = caseID;
    for (const item of input.items) {
      item.problemKey = caseID;
      item.data = {
        ...item.data,
        ...(assessment
          ? { assessment: JSON.parse(assessmentJSON(assessment)) }
          : {}),
        sourceRevision: header.sourceRevision,
        sourceFingerprint: header.sourceFingerprint,
      };
    }
    const existing = await activeCaseAction(caseID, input.operationKey!);
    if (existing) {
      const link = await cds.ql.SELECT.one.from(`${NS}.CaseActions`).where({
        header_ID: caseID,
        action_ID: existing.ID,
        operation: input.operationKey!,
      });
      if (link?.sourceFingerprint !== header.sourceFingerprint)
        throw fail(
          409,
          "The active approval uses older evidence; review the updated case before preparing again",
        );
      if (header.kind === "supplier_planned_time") {
        const items = await cds.ql.SELECT.from(`${NS}.ActionItems`)
          .where({ action_ID: existing.ID })
          .orderBy("line");
        if (
          items.length !== input.items.length ||
          items.some(
            (item: Row, index: number) =>
              item.field !== input.items[index]?.field ||
              item.newValue !== String(input.items[index]?.newValue ?? ""),
          )
        )
          throw fail(
            409,
            "The active approval contains a different planned-time selection; inspect or decline it before preparing another",
          );
      }
      if (currentWorkflowCommand()) {
        const items = await cds.ql.SELECT.from(`${NS}.ActionItems`)
          .where({ action_ID: existing.ID }).orderBy("line");
        const fields = ["objectKey", "field", "oldValue", "newValue", "text"] as const;
        if (items.length !== input.items.length || items.some((item: Row, index: number) =>
          fields.some(field => String(item[field] ?? "") !== String(input.items[index]?.[field] ?? "")) ||
          !isDeepStrictEqual(
            item.data ? JSON.parse(item.data) : null,
            JSON.parse(JSON.stringify(input.items[index]?.data ?? null)),
          )) ||
          String(existing.responsiblePerson ?? "") !== String(input.responsiblePerson ?? "") ||
          String(existing.responsibleMessage ?? "") !== String(input.responsibleMessage ?? ""))
          throw fail(409, "The active approval contains different instructions; inspect or decline it before preparing another");
      }
      await acknowledgeSourceChange(caseID, header.sourceFingerprint);
      return readAction(existing.ID);
    }
    if (context.findingID) {
      input.findingID = context.findingID;
      for (const item of input.items) item.findingID = context.findingID;
    }
    return reuse409(() => prepareAction(input));
  });
}

export const prepareDeliveryCase = (
  caseID: string,
  via: ActionVia,
  user: cds.User,
  findingID?: string,
) => prepareCaseAction(caseID, via, user, { findingID });
