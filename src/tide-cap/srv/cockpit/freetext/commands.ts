import type cds from "@sap/cds";
import { registerCasePreparationCommand } from "../kernel/case-preparation";
import { prepareRequisitionCase, typedReviewCommand } from "./review";

export function registerRequisitionCommands(srv: cds.Service) {
  registerCasePreparationCommand("requisition_review", prepareRequisitionCase);
  srv.on("submitReview", "RequisitionReviews", (req) => typedReviewCommand(req, "submit"));
  srv.on("reconcileSource", "RequisitionReviews", (req) => typedReviewCommand(req, "reconcile"));
}
