import cds from "@sap/cds";
import { sanitizeErrors } from "./core/errors";
import {
  COMMAND_ARGUMENTS,
  TOOL_COMMANDS,
  resolveAssistantContext,
} from "./cockpit/mcp";
import { TURN_CHECKS } from "./cockpit/chat-view";
import { fail } from "./cockpit/kernel/errors";

const APPS: Record<string, { service: string; checked: boolean }> = {
  cockpit: { service: "CockpitMcpService", checked: true },
};

export default class AssistantRuntimeService extends cds.ApplicationService {
  async init() {
    sanitizeErrors(this);

    this.on("profile", (req: cds.Request) => {
      const app = APPS[req.data.app];
      if (!app) throw fail(404, `No assistant app ${req.data.app}`);
      const def = (cds.model as any).definitions;
      const actionTools = Object.keys(def)
        .filter(
          (name) =>
            name.startsWith(`${app.service}.`) &&
            def[name]["@assistant.action"],
        )
        .map((name) => name.slice(app.service.length + 1))
        .sort();
      return {
        app: req.data.app,
        checked: app.checked,
        actionTools,
        checks: app.checked ? JSON.stringify(TURN_CHECKS) : "{}",
      };
    });

    this.on("resolve_context", (req: cds.Request) =>
      resolveAssistantContext(req),
    );

    // A receipted tool may commit as one of several workflow commands; the receipt's type decides.
    this.on("command_result", async (req: cds.Request) => {
      const { tool, commandID } = req.data;
      const events = TOOL_COMMANDS[tool];
      if (!events) throw fail(400, `${tool} is not a receipted tool`);
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(req.data.arguments);
      } catch {
        throw fail(400, "arguments must be a JSON object");
      }
      const workflow = await cds.connect.to("WorkflowService");
      let mismatch: unknown;
      for (const event of events) {
        const narrowed = Object.fromEntries(
          COMMAND_ARGUMENTS[event].map((k) => [k, args[k] ?? null]),
        );
        try {
          return await workflow.tx(req).send("commandResult", {
            commandID,
            commandType: event,
            arguments: JSON.stringify(narrowed),
          });
        } catch (error: any) {
          if (error?.status !== 409 && error?.code !== 409) throw error;
          mismatch = error;
        }
      }
      throw mismatch;
    });

    return super.init();
  }
}
