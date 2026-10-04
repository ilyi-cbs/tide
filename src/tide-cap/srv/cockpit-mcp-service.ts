import cds from "@sap/cds";
import { sanitizeErrors } from "./core/errors";
import { registerCockpitTools } from "./cockpit/mcp";

export default class CockpitMcpService extends cds.ApplicationService {
  async init() {
    sanitizeErrors(this);
    registerCockpitTools(this);
    return super.init();
  }
}
