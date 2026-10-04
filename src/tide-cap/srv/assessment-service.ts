import cds from "@sap/cds";
import { assessPrevention } from "./cockpit/kernel/prevention-assessment";

export default class AssessmentService extends cds.ApplicationService {
  async init() {
    this.on("assessPrevention", (req: cds.Request) =>
      assessPrevention(String(req.data.caseID ?? ""), req.user, req.data),
    );
    return super.init();
  }
}
