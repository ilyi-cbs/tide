// Wires the kernel into PurchasingDeskService.init(): every feature's register(srv)
// first, then the kernel's own handlers and the 501 stubs of the §6
// operations. CAP runs the first `on` handler of an operation, so a feature
// handler registered in register() replaces the stub.
import cds from "@sap/cds";
import { assertApprovalVisible } from "./actions";
import * as atrisk from "../atrisk";
import * as impact from "../impact";
import * as rules from "../rules";
import * as leadtimes from "../leadtimes";
import * as planning from "../planning";
import * as freetext from "../freetext";
import * as feed from "../feed";
import * as overview from "../overview";
import * as guard from "../guard";
import * as expire from "../expire";
import * as outlook from "../outlook";
import type { FeatureModule } from "./types";
import { inScope, scopeOf } from "./auth";
import {
  assessPrevention,
  assessmentJSON,
  latestAssessment,
  scopedPlanningRows,
} from "./prevention-assessment";
import { modelWork } from "./model-calls";

export const FEATURES: Record<string, FeatureModule> = {
  atrisk,
  rules,
  impact,
  leadtimes,
  planning,
  freetext,
  feed,
  overview,
  guard,
  expire,
  outlook,
};

/** Operations of §6 that the features implement (owner in the comment). */
export const STUB_OPERATIONS = [
  "enterConfirmation", // rules
  "bufferSimulator", // leadtimes
  "leadTimeRange", // leadtimes
  "planOrder", // planning
  "proposeCodes", // freetext
  "similarRequests", // freetext
  "thresholdSimulator", // freetext
  "acceptConfidentCodes", // freetext
  "overview", // overview
  "me", // guard
  "budget", // guard
];

export function registerKernel(srv: cds.Service) {
  for (const f of Object.values(FEATURES)) f.register(srv);
  for (const entity of ["SupplierPlannedTimes", "MaterialPlannedTimes"]) {
    srv.after("READ", entity, async (result: unknown) => {
      const rows = (Array.isArray(result) ? result : [result]).filter(
        (row) => row?.header_ID,
      ) as Record<string, any>[];
      if (!rows.length) return;
      const details = await cds.ql.SELECT.from(`tide.cockpit.${entity}`)
        .columns("header_ID", "detail")
        .where({ header_ID: { in: rows.map((row) => row.header_ID) } });
      const byID = new Map(
        details.map((row: Record<string, any>) => [row.header_ID, row.detail]),
      );
      for (const row of rows) {
        let detail: Record<string, any> = {};
        try {
          const parsed = JSON.parse(String(byID.get(row.header_ID) ?? "{}"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            detail = parsed;
        } catch {
          detail = {};
        }
        if (entity === "MaterialPlannedTimes") {
          row.proposalRule =
            typeof detail.proposalRule === "string"
              ? detail.proposalRule
              : null;
        } else {
          for (const quantile of ["P10", "P50", "P80", "P90"]) {
            const value =
              detail[`range${quantile}`] ?? detail[quantile.toLowerCase()];
            row[`range${quantile}`] =
              typeof value === "number" && Number.isFinite(value) && value >= 0
                ? value
                : null;
          }
          row.rangeSource =
            detail.rangeSource ?? (row.rangeP50 !== null ? "empirical" : null);
        }
      }
    });
  }
  // Bound actions do not run READ handlers. Authorize the business root before
  // any handler can mutate raw persistence or expose its evidence.
  const legacyCases = [
    "Findings",
    "FulfillmentRisks",
    "PriceFindings",
    "DuplicateFindings",
    "RareSettingFindings",
    "SupplierPlannedTimeFindings",
    "MaterialMasterPlannedTimeFindings",
  ];
  const typedCases = [
    "DeliveryRisks",
    "PriceDeviations",
    "DuplicateMaterials",
    "UnusualSettings",
    "SupplierPlannedTimes",
    "MaterialPlannedTimes",
    "RequisitionReviews",
  ];
  for (const entity of [...legacyCases, ...typedCases]) {
    const actions = Object.keys((srv.entities[entity] as any)?.actions ?? {});
    for (const action of actions)
      srv.before(action, entity, async (req: cds.Request) => {
        const [key] = req.params as any[];
        const ID = String(
          typeof key === "object" ? (key.header_ID ?? key.ID) : key,
        );
        const read = () =>
          cds.ql.SELECT.one
            .from(
              legacyCases.includes(entity)
                ? "tide.cockpit.Finding"
                : "tide.cockpit.Cases",
            )
            .where({ ID });
        const row =
          action === "assessPrevention"
            ? await modelWork(() => cds.tx(read))
            : await read();
        if (!row || !inScope(scopeOf(req.user), row))
          return req.reject(404, "Case not found");
      });
  }
  srv.before(["queueForLater", "prepareFindingAction", "prepareAction", "acceptException"],
    [...legacyCases, ...typedCases], (req: cds.Request) =>
      req.reject(410, "This writer is retired; use WorkflowService with commandID and reviewed evidence"));
  srv.before(["decide", "decline", "logOutcome"], "Actions", async (req: cds.Request) => {
    const [key] = req.params as any[];
    await assertApprovalVisible(String(typeof key === "object" ? key.ID : key), req.user);
    return req.reject(410, "This writer is retired; use WorkflowService with commandID and the reviewed Action version");
  });
  srv.before(["submitReview", "submitForApproval", "submitReviewedOrder"],
    ["PurchaseRequisitionReviews", "RequisitionReviews"], (req: cds.Request) =>
      req.reject(410, "Review submission requires WorkflowService.submitRequisitionReview and its checked summary token"));
  srv.on("ignoreConfirmed", "FulfillmentRisks", async (req: cds.Request) => {
    const [key] = req.params as any[];
    const ID = String(typeof key === "object" ? key.ID : key);
    const finding = await cds.ql.SELECT.one
      .from("tide.cockpit.Finding")
      .where({ ID });
    if (!finding || !["at_risk", "overdue"].includes(finding.list))
      return req.reject(404, "Delivery finding not found");
    const confirmation = await cds.ql.SELECT.one
      .from("tide.cockpit.Confirmation")
      .where({
        PurchaseOrder: finding.PurchaseOrder,
        PurchaseOrderItem: finding.PurchaseOrderItem,
      });
    if (!confirmation)
      return req.reject(
        409,
        "A supplier confirmation is required before ignoring this delivery risk",
      );
    return req.reject(
      409,
      "A supplier confirmation updates the evidence but does not resolve the open delivery obligation",
    );
  });
  for (const entity of [
    "PriceDeviations",
    "DuplicateMaterials",
    "UnusualSettings",
    "SupplierPlannedTimes",
    "MaterialPlannedTimes",
  ]) {
    srv.on("assessPrevention", entity, (req: cds.Request) => {
      const [key] = req.params as any[];
      return assessPrevention(
        String(typeof key === "object" ? (key.header_ID ?? key.ID) : key),
        req.user,
        req.data,
      );
    });
    srv.after("READ", entity, async (result: any, req: cds.Request) => {
      for (const row of (Array.isArray(result) ? result : [result]).filter(
        Boolean,
      )) {
        if (!row.header_ID) continue;
        const header = await cds.ql.SELECT.one
          .from("tide.cockpit.Cases")
          .where({ ID: row.header_ID });
        const assessment =
          header &&
          (await latestAssessment(row.header_ID, header.sourceFingerprint));
        row.assessmentJson = assessment ? assessmentJSON(assessment) : null;
        if (entity === "DuplicateMaterials") {
          const source = await cds.ql.SELECT.one
            .from("tide.cockpit.DuplicateMaterials")
            .where({ header_ID: row.header_ID });
          const materials = new Set(
            String(source?.materialNumbers || source?.Material || "")
              .split(",")
              .map((material) => material.trim())
              .filter(Boolean),
          );
          const plant = source?.Plant || source?.mainPlant;
          const planningRows = plant
            ? await scopedPlanningRows(plant, req.user)
            : [];
          row.currentPlanning = planningRows
            .filter((entry) => materials.has(entry.Material))
            .map((entry) => ({
              Material: entry.Material,
              Plant: entry.Plant,
              BaseUnit: entry.BaseUnit,
              ProcurementType: entry.ProcurementType,
              ProcurementSubType: entry.ProcurementSubType,
              MRPType: entry.MRPType,
              LotSizingProcedure: entry.LotSizingProcedure,
              MRPResponsible: entry.MRPResponsible,
            }));
        }
      }
    });
  }
  for (const op of STUB_OPERATIONS)
    srv.on(op, (req: cds.Request) =>
      req.reject({
        status: 501,
        code: "NOT_IMPLEMENTED",
        message: `${op} is not implemented yet`,
        notImplemented: true,
        notImplementedMessage: op,
      } as any),
    );
  // sanitizeErrors (registered before) turns every error >= 500 into a generic
  // 500; a stub's 501 is safe to show, so restore it.
  srv.on("error", (err: any) => {
    const stub = err?.notImplemented ? err : null;
    if (!stub) return;
    stub.status = 501;
    stub.code = "NOT_IMPLEMENTED";
    stub.message = `${stub.notImplementedMessage ?? "This operation"} is not implemented yet`;
  });
}
