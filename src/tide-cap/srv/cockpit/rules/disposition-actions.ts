import type { PrepareActionInput } from "../kernel/actions";
import type { Row } from "../kernel/model-calls";
import type { ActionVia } from "../kernel/types";
import { findingProblemKey } from "../kernel/identity";

export async function duplicateMdgAction(
  f: Row,
  via: ActionVia,
): Promise<PrepareActionInput> {
  return {
    kind: "mdg_case",
    objectKey: String(f.objectKey),
    problemKey: findingProblemKey(f),
    operationKey: "master_data_duplicate_review",
    exportFormat: "csv",
    via,
    findingID: f.ID,
    requestType: "Duplicate Materials",
    chain: f.chain ?? null,
    title: `MDG duplicate review: ${f.itemTitle}`,
    summary:
      "Review candidate materials side by side and decide whether master-data governance should act.",
    items: [
      {
        objectKey: String(f.objectKey),
        problemKey: findingProblemKey(f),
        operationKey: "master_data_duplicate_review",
        findingID: f.ID,
        text: String(f.issue),
        data: { materials: f.duplicateDetail?.materialNumbers ?? null },
      },
    ],
  };
}

export async function rarePlannerAction(
  f: Row,
  via: ActionVia,
): Promise<PrepareActionInput> {
  return {
    kind: "planner_review",
    objectKey: String(f.objectKey),
    problemKey: findingProblemKey(f),
    operationKey: "planner_review",
    exportFormat: "csv",
    via,
    findingID: f.ID,
    requestType: "Configuration Review",
    chain: f.chain ?? null,
    title: `Configuration review: ${f.itemTitle}`,
    summary:
      "Is this configuration intentional and appropriate for this material and plant? Keep intentional settings with a rationale, investigate missing evidence, or propose specific corrections for separate approval. Rarity alone does not justify a change; PDT corrections belong in the Planned Delivery Time workflow.",
    items: [
      {
        objectKey: String(f.objectKey),
        problemKey: findingProblemKey(f),
        operationKey: "planner_review",
        findingID: f.ID,
        text: String(f.issue),
        data: {
          pair: f.rareDetail?.firstPair ?? null,
          Material: f.Material,
          Plant: f.Plant,
          reviewQuestion:
            "Is this configuration intentional and appropriate for this material and plant?",
          reviewOutcomes: [
            "Keep settings with rationale",
            "Investigate missing evidence",
            "Propose specific corrections for separate approval",
          ],
          automaticSettingChange: false,
        },
      },
    ],
  };
}
