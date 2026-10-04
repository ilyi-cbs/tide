import cds from "@sap/cds";

export default class ReviewService extends cds.ApplicationService {
  async init() {
    this.on("requestsWorkflowSummary", async (req: cds.Request) => {
      const cockpit = await cds.connect.to("PurchasingDeskService");
      return cockpit.tx(req).send("requestsWorkflowSummary", req.data);
    });
    for (const operation of ["submitRequisitionReview", "commandResult"]) {
      this.on(operation, async (req: cds.Request) => {
        const workflow = await cds.connect.to("WorkflowService");
        return workflow.tx(req).send(operation, req.data);
      });
    }
    return super.init();
  }
}
