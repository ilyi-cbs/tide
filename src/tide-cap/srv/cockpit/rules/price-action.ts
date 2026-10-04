// Price findings prepare a clarification, never an automatic PO price write.
import type { PrepareActionInput } from "../kernel/actions";
import type { Row } from "../kernel/model-calls";
import type { ActionKind, ActionVia } from "../kernel/types";
import { fmtAmount } from "./domain";
import { findingProblemKey } from "../kernel/identity";

export async function priceAction(
  f: Row,
  via: ActionVia,
): Promise<PrepareActionInput> {
  const x: Row = f.priceDetail ?? {};
  const key = f.PurchaseOrder
    ? `${f.PurchaseOrder}/${f.PurchaseOrderItem}`
    : String(f.objectKey);
  const qty = Number(x.priceQuantity) || 1;
  const current =
    x.currentPrice ??
    (x.unitPrice != null ? Math.round(x.unitPrice * qty * 100) / 100 : null);
  const typical = x.priorMedian ?? null;
  const model =
    x.assessmentSource === "tabpfn" &&
    x.expectedP50 != null &&
    Number.isFinite(Number(x.expectedP50));
  const expected = model ? Number(x.expectedP50) : null;
  const reference = model ? Math.round(expected! * qty * 100) / 100 : typical;
  const per = qty === 1 ? "" : ` per ${qty}`;
  const reason = String(f.issue ?? "Price differs from earlier prices");
  const problemKey = findingProblemKey(f);
  return {
    kind: "price_clarification" as ActionKind,
    objectKey: f.objectKey ?? key,
    problemKey,
    operationKey: "price_clarification",
    exportFormat: "csv",
    via,
    findingID: f.ID,
    requestType: "Price Deviation",
    chain: f.chain ?? null,
    title: `Price clarification: ${f.itemTitle || key}`,
    summary: [reason, f.impactText].filter(Boolean).join(" · "),
    items: [
      {
        objectKey: key,
        problemKey,
        operationKey: "price_clarification",
        findingID: f.ID,
        field: "NetPriceAmount (review only)",
        oldValue: current == null ? null : String(current),
        newValue: reference == null ? null : String(reference),
        text: `Clarify PO ${key} with the supplier or responsible buyer: entered net price ${fmtAmount(current, x.currency)}${per}; ${model ? `TabPFN expected normalized unit price ${fmtAmount(expected, x.currency)} (P10-P90 ${fmtAmount(x.expectedP10, x.currency)}-${fmtAmount(x.expectedP90, x.currency)}); reference net price ${fmtAmount(reference, x.currency)}${per}; ` : ""}empirical historical unit-price median ${fmtAmount(typical, x.currency)}. No SAP price is changed by this action. ${reason}`,
        data: {
          PurchaseOrder: f.PurchaseOrder,
          PurchaseOrderItem: f.PurchaseOrderItem,
          source: model ? "tabpfn" : (x.assessmentSource ?? f.source ?? "rule"),
          priceQuantity: qty,
          currentUnitPrice: x.unitPrice ?? null,
          empiricalEvidence: {
            median: typical,
            observations: x.priorCount ?? null,
          },
          modelEvidence: model
            ? {
                expectedP10: x.expectedP10 ?? null,
                expectedP50: expected,
                expectedP90: x.expectedP90 ?? null,
                runID: x.assessmentRunID ?? null,
                calibrationStatus: x.calibrationStatus ?? "uncalibrated",
                deviationPercent: x.deviationPercent ?? null,
              }
            : null,
          reason,
          currency: x.currency ?? null,
        },
      },
    ],
  };
}
