import cds from "@sap/cds";
import { executeWorkflowCommand } from "../../srv/cockpit/kernel/commands";

const ADMIN = new cds.User({
  id: "ilyesse.hettenbach@cbs-consulting.de",
  roles: ["admin", "user"],
  attr: {},
});

// Kernel state tests run lifecycle writers inside a committed workflow command,
// the only context in which WorkflowService lets them change Cases or Actions.
export function asWorkflowCommand<Result>(
  work: () => Promise<Result>,
  user: cds.User = ADMIN,
): Promise<Result> {
  return cds.tx({ user }, () =>
    executeWorkflowCommand(
      {
        commandID: `test:${cds.utils.uuid()}`,
        commandType: "test",
        arguments: {},
        subjects: [{ kind: "case", ID: "test" }],
      },
      {
        authorize: async () => {},
        execute: async () => ((await work()) ?? null) as Result,
      },
    ),
  );
}
