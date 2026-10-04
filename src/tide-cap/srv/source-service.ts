import cds from "@sap/cds";
import { handle, ingest } from "./cockpit/feed/feed";

export default class SourceService extends cds.ApplicationService {
  async init() {
    this.on("ingest", (req: cds.Request) => handle(req, ingest)());
    return super.init();
  }
}
