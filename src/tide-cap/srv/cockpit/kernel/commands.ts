import cds from "@sap/cds";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { fail } from "./errors";
import { inTx } from "./model-calls";

const ENTITY = "tide.workflow.WorkflowCommands";
const APP = "tide.cockpit";
const { INSERT, SELECT, UPDATE } = cds.ql;
const commandContext = new AsyncLocalStorage<string>();
const originContext = new AsyncLocalStorage<"app" | "mcp">();

export const currentWorkflowCommand = () => commandContext.getStore();
export const currentWorkflowOrigin = () => originContext.getStore() ?? "app";
export const withWorkflowOrigin = <Result>(origin: "app" | "mcp", work: () => Promise<Result>) =>
  originContext.run(origin, work);

export interface CommandSubject {
  kind: "case" | "action" | "review";
  ID: string;
}

export interface WorkflowCommand {
  commandID: string;
  commandType: string;
  arguments: Record<string, unknown>;
  subjects: readonly CommandSubject[];
}

interface CommandWork<Result> {
  authorize: (subjects: readonly CommandSubject[]) => Promise<void>;
  execute: (receiptID: string) => Promise<Result>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw fail(400, "Command arguments must contain JSON values");
}

function argumentHash(commandType: string, args: Record<string, unknown>, subjects: readonly CommandSubject[]) {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ commandType, arguments: args, subjects })))
    .digest("hex");
}

function required(value: string, name: string, maximum: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maximum
  )
    throw fail(
      400,
      `${name} must be a nonblank string of at most ${maximum} characters`,
    );
  return value;
}

export async function executeWorkflowCommand<Result>(
  command: WorkflowCommand,
  work: CommandWork<Result>,
): Promise<Result> {
  const principal = cds.context?.user?.id;
  if (!principal || principal === "anonymous")
    throw fail(401, "A trusted caller is required");
  const identity = {
    tenant: cds.context?.tenant ?? "",
    principal,
    app: APP,
    commandID: required(command.commandID, "commandID", 128),
  };
  const commandType = required(command.commandType, "commandType", 80);
  if (!command.subjects.length)
    throw fail(400, "A command must identify its affected subjects");
  const subjects = [...command.subjects]
    .map((subject) => ({
      kind: subject.kind,
      ID: required(subject.ID, "subject ID", 160),
    }))
    .sort((left, right) =>
      `${left.kind}:${left.ID}`.localeCompare(`${right.kind}:${right.ID}`),
    );
  const argsHash = argumentHash(commandType, command.arguments, subjects);

  return inTx(async () => {
    const ID = cds.utils.uuid();
    try {
      await INSERT.into(ENTITY).entries({
        ...identity,
        ID,
        commandType,
        argsHash,
        subjects: JSON.stringify(subjects),
      });
    } catch (error) {
      const receipt = await SELECT.one.from(ENTITY).where(identity);
      if (!receipt) throw error;
      await work.authorize(JSON.parse(receipt.subjects));
      if (receipt.commandType !== commandType || receipt.argsHash !== argsHash)
        throw fail(409, "commandID was already used with different arguments");
      if (!receipt.committedAt || receipt.result == null)
        throw fail(
          409,
          "Command has no committed result; reconcile before retrying",
        );
      return JSON.parse(receipt.result) as Result;
    }
    await work.authorize(subjects);
    const result = await commandContext.run(ID, () => work.execute(ID));
    const serialized = JSON.stringify(result);
    if (serialized === undefined)
      throw fail(500, "A command must produce a persisted result");
    await UPDATE.entity(ENTITY)
      .set({ result: serialized, committedAt: new Date().toISOString() })
      .where({ ID });
    return JSON.parse(serialized) as Result;
  });
}

export async function readWorkflowCommandResult<Result>(
  commandID: string,
  authorize: CommandWork<Result>["authorize"],
  expected?: { commandType?: string; arguments?: string },
): Promise<Result | null> {
  const principal = cds.context?.user?.id;
  if (!principal || principal === "anonymous")
    throw fail(401, "A trusted caller is required");
  const receipt = await SELECT.one.from(ENTITY).where({
    tenant: cds.context?.tenant ?? "",
    principal,
    app: APP,
    commandID: required(commandID, "commandID", 128),
  });
  if (!receipt) return null;
  const subjects = JSON.parse(receipt.subjects);
  await authorize(subjects);
  if (!receipt.committedAt || receipt.result == null)
    throw fail(
      409,
      "Command has no committed result; reconcile before retrying",
    );
  const result = JSON.parse(receipt.result) as Result;
  if (expected?.commandType == null && expected?.arguments == null) return result;
  const commandType = required(expected?.commandType!, "commandType", 80);
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(expected?.arguments!);
  } catch {
    throw fail(400, "arguments must be a JSON object");
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw fail(400, "arguments must be a JSON object");
  if (receipt.commandType !== commandType || receipt.argsHash !== argumentHash(commandType, args, subjects))
    throw fail(409, "commandID was already used with different arguments");
  return { ...result, commandID, commandType, payloadMatched: true };
}
