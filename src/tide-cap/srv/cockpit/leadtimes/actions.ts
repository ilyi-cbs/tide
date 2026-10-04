// pdt_change action of a pdt / mm_pdt finding: its typed detail proposal as
// one change-list line.
import cds from "@sap/cds";
import type { ActionVia } from "../kernel/types";
import type { PrepareActionInput } from "../kernel/actions";
import type { Row } from "../kernel/model-calls";
import { fail } from "../kernel/errors";
import { findingProblemKey } from "../kernel/identity";
import { materialSetting, supplierSetting } from "../kernel/typed-cases";

export async function pdtChangeAction(
  f: Row,
  via: ActionVia,
  days?: number | null,
): Promise<PrepareActionInput> {
  const e = f.list === "mm_pdt" ? (f.mmPdtDetail ?? {}) : (f.pdtDetail ?? {});
  const proposal = days ?? e.proposalDays;
  const purchasingInfoRecord = e.PurchasingInfoRecord ?? e.purchasingInfoRecord;
  const maintained = f.list === "mm_pdt" ? e.masterDays : e.currentDays;
  if (
    days != null &&
    (!Number.isInteger(days) || days <= 0 || days > 365 || days === maintained)
  )
    throw fail(
      400,
      "Select a different planned delivery time between 1 and 365 days",
    );
  if (
    (!Number.isInteger(proposal) ||
      proposal <= 0 ||
      proposal > 365 ||
      proposal === maintained) &&
    (e.settingRecheck || e.settingComparison?.trigger)
  ) {
    const problemKey = findingProblemKey(f);
    return {
      kind: "planner_review",
      operationKey: "planner_review",
      objectKey: f.objectKey,
      problemKey,
      via,
      requestType:
        f.list === "mm_pdt" ? "Material Planned Time" : "Supplier Planned Time",
      title: `Review planned delivery time: ${f.Material}`,
      summary:
        "Independent model evidence requires review; no valid policy proposal is available.",
      items: [
        {
          objectKey: f.objectKey,
          problemKey,
          operationKey: "planner_review",
          text: f.issue,
          data: {
            settingRecheck: e.settingRecheck,
            settingComparison: e.settingComparison,
            settingRange: e.settingRange,
            proposalDays: null,
          },
        },
      ],
    };
  }
  if (!Number.isInteger(proposal) || proposal <= 0 || proposal > 365)
    throw fail(
      409,
      "There is no proposal for this planned delivery time yet (too few past deliveries)",
    );
  const mm = f.list === "mm_pdt";
  const current = mm ? e.masterDays : e.currentDays;
  const field =
    mm || e.currentFrom === "material master"
      ? "PlannedDeliveryDurationInDays"
      : "MaterialPlannedDeliveryDurn";
  const object = mm
    ? `Material ${f.Material}, plant ${f.Plant}`
    : `Info record ${purchasingInfoRecord ?? "-"}, plant ${f.Plant}`;
  const reason = mm
    ? "order-share weighted median of the suppliers"
    : days != null
      ? "buyer-selected duration; review required"
      : "p80 of own lead times";
  const problemKey = findingProblemKey({
    ...f,
    [mm ? "mmPdtDetail" : "pdtDetail"]: e,
  });
  return {
    kind: "pdt_change",
    objectKey: f.objectKey,
    problemKey,
    operationKey: "pdt_change",
    exportFormat: "csv",
    via,
    findingID: f.ID,
    requestType: mm ? "Material Planned Time" : "Supplier Planned Time",
    chain: f.chain,
    title: `Planned delivery time ${f.itemTitle ?? f.Material}: ${current ?? "-"} → ${proposal} days`,
    summary: f.issue,
    items: [
      {
        objectKey: mm ? f.objectKey : purchasingInfoRecord || f.objectKey,
        problemKey,
        operationKey: "pdt_change",
        findingID: f.ID,
        field,
        oldValue:
          current === null || current === undefined ? "" : String(current),
        newValue: String(proposal),
        text: `${object}: planned delivery time ${current ?? "-"} → ${proposal} days (${reason})`,
        data: {
          source: f.source,
          reason: f.issue,
          Material: f.Material,
          Supplier: f.Supplier,
          Plant: f.Plant,
          PurchasingInfoRecord: purchasingInfoRecord ?? null,
          PurchasingOrganization:
            e.PurchasingOrganization ?? e.purchasingOrganization ?? null,
          PurchasingInfoRecordCategory:
            e.PurchasingInfoRecordCategory ??
            e.purchasingInfoRecordCategory ??
            null,
          currentFrom: e.currentFrom ?? null,
          currentDays: current ?? null,
          proposalDays: e.proposalDays ?? null,
          selectedDays: proposal,
          selection: days != null ? "buyer" : "proposal",
          proposalRule:
            e.proposalRule ?? (mm ? "order-share weighted median" : "p80"),
          ownDeliveries: e.ownDeliveries ?? e.nOwn ?? null,
          evidence: e,
          quantiles: {
            p10: e.p10 ?? null,
            p50: e.p50 ?? null,
            p80: e.p80 ?? null,
            p90: e.p90 ?? null,
          },
        },
      },
    ],
  };
}

export async function reconcileSupplierPlannedTimes() {
  return reconcilePlannedTimes("supplier_planned_time");
}

export async function reconcileMaterialPlannedTimes() {
  return reconcilePlannedTimes("material_planned_time");
}

async function reconcilePlannedTimes(
  kind: "supplier_planned_time" | "material_planned_time",
) {
  const supplier = kind === "supplier_planned_time";
  const { freshFieldObservation } = await import("../kernel/feed-journal.js");
  const { executeWorkflowCommand } = await import("../kernel/commands.js");
  const { createHash } = await import("node:crypto");
  const { fail } = await import("../kernel/errors.js");
  const { inCommandScope } = await import("../kernel/auth.js");
  const { resolveDetectorCase } = await import("../kernel/detector-writers.js");
  const { logOutcome } = await import("../kernel/action-state.js");
  const cases: Row[] = await cds.ql.SELECT.from("tide.cockpit.Cases").where({
    kind,
    status: "open",
  });
  let resolved = 0;
  for (const header of cases) {
    const links: Row[] = await cds.ql.SELECT.from("tide.cockpit.CaseActions")
      .where({ header_ID: header.ID, operation: "pdt_change" })
      .orderBy("createdAt desc", "action_ID desc")
      .limit(1);
    for (const link of links) {
      const action = await cds.ql.SELECT.one
        .from("tide.cockpit.Actions")
        .where({ ID: link.action_ID });
      if (
        !action?.decidedAt ||
        !["waiting", "resolved"].includes(action.status)
      )
        continue;
      if (
        await cds.ql.SELECT.one
          .from("tide.workflow.OutcomeObservations")
          .where({
            actionID: action.ID,
            kind: "source_confirmed",
            origin: "source_refresh",
          })
      )
        continue;
      const items: Row[] = await cds.ql.SELECT.from(
        "tide.cockpit.ActionItems",
      ).where({ action_ID: action.ID });
      if (items.length !== 1) continue;
      const item = items[0]!;
      let evidence: Row;
      try {
        evidence = JSON.parse(item.data ?? "{}");
      } catch {
        continue;
      }
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
        continue;
      const selected = Number(item.newValue);
      if (
        !Number.isInteger(selected) ||
        selected < 1 ||
        selected > 365 ||
        !evidence.Material ||
        (supplier && !evidence.Supplier) ||
        !evidence.Plant
      )
        continue;
      let source: Row | undefined;
      let sourceEntity: string | undefined;
      if (
        supplier &&
        item.field === "MaterialPlannedDeliveryDurn" &&
        evidence.PurchasingInfoRecord
      ) {
        const rows: Row[] = await cds.ql.SELECT.from(
          "tide.s4.PurgInfoRecdOrgPlantData",
        ).where({
          Material: evidence.Material,
          Supplier: evidence.Supplier,
          Plant: evidence.Plant,
          PurchasingInfoRecord: evidence.PurchasingInfoRecord,
          ...(evidence.PurchasingOrganization
            ? { PurchasingOrganization: evidence.PurchasingOrganization }
            : {}),
          ...(evidence.PurchasingInfoRecordCategory
            ? {
                PurchasingInfoRecordCategory:
                  evidence.PurchasingInfoRecordCategory,
              }
            : {}),
        }).where`IsMarkedForDeletion is null or IsMarkedForDeletion = false`;
        if (
          rows.length === 1 &&
          Number(rows[0]!.MaterialPlannedDeliveryDurn) === selected
        ) {
          source = rows[0];
          sourceEntity = "PurgInfoRecdOrgPlantData";
        }
      } else if (
        item.field === "PlannedDeliveryDurationInDays" &&
        (!supplier || evidence.currentFrom === "material master")
      ) {
        const row = await cds.ql.SELECT.one
          .from("tide.s4.ProductPlantSupplyPlanning")
          .where({ Product: evidence.Material, Plant: evidence.Plant });
        if (row && Number(row.PlannedDeliveryDurationInDays) === selected) {
          source = row;
          sourceEntity = "ProductPlantSupplyPlanning";
        }
      }
      if (!source || !sourceEntity) continue;
      const observation = await freshFieldObservation(
        sourceEntity,
        source,
        item.field,
        action.decidedAt,
      );
      if (!observation) continue;
      const arguments_ = {
        caseID: header.ID,
        actionID: action.ID,
        caseModifiedAt: header.modifiedAt,
        actionModifiedAt: action.modifiedAt,
        sourceEntity,
        sourceObservationID: String(observation.ID),
        target: item.objectKey,
        field: item.field,
        value: item.newValue,
      };
      await executeWorkflowCommand(
        {
          commandID: `${supplier ? "supplier" : "material"}-source:${createHash("sha256").update(JSON.stringify(arguments_)).digest("hex")}`,
          commandType: supplier
            ? "reconcileSupplierPlannedTime"
            : "reconcileMaterialPlannedTime",
          arguments: arguments_,
          subjects: [
            { kind: "case", ID: header.ID },
            { kind: "action", ID: action.ID },
          ],
        },
        {
          authorize: async () => {
            const current = await cds.ql.SELECT.one
              .from("tide.cockpit.Cases")
              .where({ ID: header.ID });
            if (!current || !inCommandScope(cds.context!.user, current))
              throw fail(404, "Case not found");
            const currentLinks: Row[] = await cds.ql.SELECT.from(
              "tide.cockpit.CaseActions",
            ).where({ action_ID: action.ID });
            for (const currentLink of currentLinks) {
              const linked = await cds.ql.SELECT.one
                .from("tide.cockpit.Cases")
                .where({ ID: currentLink.header_ID });
              if (!linked || !inCommandScope(cds.context!.user, linked))
                throw fail(404, "Case not found");
            }
          },
          execute: async (receiptID) => {
            const currentCase = await cds.ql.SELECT.one
              .from("tide.cockpit.Cases")
              .where({ ID: header.ID });
            const currentAction = await cds.ql.SELECT.one
              .from("tide.cockpit.Actions")
              .where({ ID: action.ID });
            if (
              currentCase?.status !== "open" ||
              currentCase?.modifiedAt !== header.modifiedAt ||
              currentAction?.modifiedAt !== action.modifiedAt
            )
              throw fail(
                409,
                "Planned-time source reconciliation became stale",
              );
            if (
              await cds.ql.SELECT.one
                .from("tide.workflow.OutcomeObservations")
                .where({
                  actionID: action.ID,
                  kind: "source_confirmed",
                  origin: "source_refresh",
                })
            )
              throw fail(
                409,
                "This Action's source proof was already consumed",
              );
            const sourceKeys = JSON.parse(
              (
                await cds.ql.SELECT.one
                  .from("tide.cockpit.FeedJournal")
                  .where({ ID: observation.ID })
              )?.keys ?? "null",
            );
            const currentSource =
              sourceKeys &&
              (await cds.ql.SELECT.one
                .from(`tide.s4.${sourceEntity}`)
                .where(sourceKeys));
            const currentObservation =
              currentSource &&
              (await freshFieldObservation(
                sourceEntity,
                currentSource,
                item.field,
                action.decidedAt,
              ));
            if (
              !currentObservation ||
              currentObservation.ID !== observation.ID ||
              Number(currentSource[item.field]) !== selected
            )
              throw fail(409, "Planned-time source observation became stale");
            const observationID = cds.utils.uuid();
            await cds.ql.INSERT.into(
              "tide.workflow.OutcomeObservations",
            ).entries({
              ID: observationID,
              actionID: action.ID,
              command_ID: receiptID,
              kind: "source_confirmed",
              completeness: "complete",
              origin: "source_refresh",
              observedAt: observation.at,
              actor: cds.context!.user.id,
              target: item.objectKey,
              field: item.field,
              value: item.newValue,
              note: `Committed source observation ${observation.ID}.`,
            });
            if (action.status === "waiting")
              await logOutcome(action.ID, {
                resolution: "posted",
                resolvedBy: "source_sync",
                note: "Refreshed source confirms the approved planned duration.",
                expectedModifiedAt: action.modifiedAt,
              });
            await resolveDetectorCase(
              header.ID,
              `Refreshed ${item.field} confirms the approved ${selected}-day duration for ${item.objectKey}.`,
              (supplier
                ? supplierSetting(evidence, {
                    ...evidence,
                    currentDays: selected,
                  })
                : materialSetting(evidence, { masterDays: selected }))!,
            );
            return {
              caseID: header.ID,
              actionID: action.ID,
              observationID,
              status: "closed",
            };
          },
        },
      );
      resolved += 1;
      break;
    }
  }
  return resolved;
}
