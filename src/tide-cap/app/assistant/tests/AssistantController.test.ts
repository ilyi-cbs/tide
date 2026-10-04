import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  AssistantController,
  contextLabelOf,
} from "../src/AssistantController";

const storage = new Map<string, string>();

/** Encodes AG-UI events as one SSE stream body, `data: {...}\n\n` per event. */
function sseBody(
  events: Record<string, unknown>[],
): ReadableStream<Uint8Array> {
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface RunCall {
  url: string;
  body: Record<string, any> | null;
}

class FetchStub {
  runs: RunCall[] = [];
  healthy = true;
  /** Queue of scripted event lists, one per POST /agent call (FIFO). */
  private readonly runQueue: Record<string, unknown>[][] = [];
  title = "A shorter title";
  titleStatus = 200;
  titleCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

  /** Thread history as GET /threads/{id} returns it (the server is authoritative). */
  private readonly histories = new Map<string, Record<string, unknown>[]>();

  queueRun(events: Record<string, unknown>[]): void {
    this.runQueue.push(events);
  }

  /** Stores a finished run the way the agent persists it in the thread. */
  private record(
    body: Record<string, any>,
    events: Record<string, unknown>[],
  ): void {
    const history = this.histories.get(body.threadId) ?? [];
    for (const message of body.messages ?? []) history.push(message);
    for (const event of events) {
      if (event.type === "TOOL_CALL_START") {
        // Same shape as the agent's GET /threads/{id} (AG-UI ToolCall dump).
        history.push({
          id: `call-${event.toolCallId}`,
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: event.toolCallId,
              type: "function",
              function: { name: event.toolCallName, arguments: '{"q":"x"}' },
            },
          ],
        });
      } else if (event.type === "TOOL_CALL_RESULT") {
        history.push({
          id: `result-${event.toolCallId}`,
          role: "tool",
          toolCallId: event.toolCallId,
          content: event.content,
        });
      }
    }
    const text = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    if (text)
      history.push({
        id: `reply-${history.length}`,
        role: "assistant",
        content: text,
      });
    this.histories.set(body.threadId, history);
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/healthz")) {
      return this.healthy
        ? new Response("{}", { status: 200 })
        : new Response("down", { status: 503 });
    }
    if (url.includes("/threads/")) {
      if (url.endsWith("/title")) {
        this.titleCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(JSON.stringify({ title: this.title }), {
          status: this.titleStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      const threadId = decodeURIComponent(url.split("/threads/")[1]);
      return new Response(
        JSON.stringify({
          thread_id: threadId,
          messages: this.histories.get(threadId) ?? [],
          pending_interrupt: false,
          interrupt: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/agent")) {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      this.runs.push({ url, body });
      const events = this.runQueue.shift() ?? [];
      if (body?.threadId) this.record(body, events);
      return new Response(sseBody(events), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

let fetchStub: FetchStub;

beforeEach(() => {
  storage.clear();
  fetchStub = new FetchStub();
  Object.assign(globalThis, {
    window: {
      location: {
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:5173",
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      clearTimeout,
      setTimeout,
    },
    fetch: fetchStub.fetch,
  });
});

test("persisted sessions are user-scoped and unidentified clients never restore another buyer's history", async () => {
  storage.set(
    "tide.assistant.conversation.cockpit",
    JSON.stringify({ conversationId: "old-thread" }),
  );
  storage.set(
    "tide.assistant.sessions.cockpit",
    JSON.stringify([
      { id: "old-thread", title: "Private request", updatedAt: 1 },
    ]),
  );
  const first = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  first.openAssistant();
  await flush();
  const firstID = first.snapshot.activeSessionId!;
  first.renameSession(firstID, "D01 private request");
  first.dispose();
  assert.equal(storage.has("tide.assistant.sessions.cockpit"), false);
  const second = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD07",
  );
  second.openAssistant();
  await flush();
  assert.notEqual(second.snapshot.activeSessionId, firstID);
  assert.equal(
    second.snapshot.sessions.some(
      (session) => session.title === "D01 private request",
    ),
    false,
  );
  second.dispose();
  const restored = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  restored.openAssistant();
  await flush();
  assert.equal(restored.snapshot.activeSessionId, firstID);
  restored.dispose();
  const saved = [...storage.entries()];
  const anonymous = new AssistantController("cockpit");
  anonymous.openAssistant();
  await flush();
  assert.notEqual(anonymous.snapshot.activeSessionId, firstID);
  anonymous.renameSession(
    anonymous.snapshot.activeSessionId!,
    "Anonymous request",
  );
  anonymous.dispose();
  assert.deepEqual([...storage.entries()], saved);
  const dottedApp = new AssistantController(
    "cockpit.buyerD01",
    undefined,
    undefined,
    undefined,
    "buyerD07",
  );
  dottedApp.openAssistant();
  await flush();
  const dottedID = dottedApp.snapshot.activeSessionId;
  dottedApp.dispose();
  const dottedUser = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01.buyerD07",
  );
  dottedUser.openAssistant();
  await flush();
  assert.notEqual(dottedUser.snapshot.activeSessionId, dottedID);
  dottedUser.dispose();
});

/** Waits for pending microtasks (fetch + stream reads) to settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("connects via healthz and updates app-scoped sessions", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant(
    { title: "Delivery", surface: "cockpit.overview" },
    { contextScope: "page" },
  );
  assert.equal(controller.snapshot.pageContext?.title, "Delivery");
  await flush();
  assert.equal(controller.snapshot.connected, true);
  assert.equal(controller.snapshot.sessions[0].title, "New conversation");

  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.sendMessage("  Need delivery  "), true);
  assert.equal(controller.snapshot.messages[0].text, "Need delivery");
  assert.equal(controller.snapshot.sessions[0].title, "Need delivery");
  await flush();
  assert.equal(fetchStub.titleCalls.length, 1);
  assert.deepEqual(fetchStub.titleCalls[0].body, { text: "Need delivery" });
  assert.equal(controller.snapshot.sessions[0].title, "A shorter title");
  assert.equal(fetchStub.runs[0].body?.messages[0].content, "Need delivery");
  assert.equal(fetchStub.runs[0].body?.pageContext?.app, "cockpit");
  assert.equal(
    fetchStub.runs[0].body?.pageContext?.surface,
    "cockpit.overview",
  );
  controller.closeAssistant();
  assert.equal(controller.snapshot.connected, false);
});

test("title generation failure leaves the immediate fallback title", async () => {
  const controller = new AssistantController("delivery-time");
  controller.openAssistant();
  await flush();
  fetchStub.titleStatus = 503;
  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.sendMessage("Please check the delayed order"), true);
  assert.equal(
    controller.snapshot.sessions[0].title,
    "Please check the delayed order",
  );
  await flush();
  assert.equal(
    controller.snapshot.sessions[0].title,
    "Please check the delayed order",
  );
  controller.dispose();
});

test("title generation does not replace a manual rename made while it is pending", async () => {
  const controller = new AssistantController("delivery-time");
  controller.openAssistant();
  await flush();
  let resolveTitle!: (response: Response) => void;
  const originalFetch = fetchStub.fetch;
  fetchStub.fetch = async (url, init) => {
    if (url.endsWith("/title"))
      return new Promise<Response>((resolve) => {
        resolveTitle = resolve;
      });
    return originalFetch(url, init);
  };
  Object.assign(globalThis, { fetch: fetchStub.fetch });
  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.sendMessage("Please check the delayed order"), true);
  controller.renameSession(
    controller.snapshot.activeSessionId!,
    "Manual title",
  );
  await flush();
  resolveTitle(
    new Response(JSON.stringify({ title: "Generated title" }), { status: 200 }),
  );
  await flush();
  assert.equal(controller.snapshot.sessions[0].title, "Manual title");
  controller.dispose();
});

test("passes structured context without changing the displayed message", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant({
    title: "Delivery risks",
    surface: "cockpit.delivery-risk-list",
    itemIDs: ["PO2-10"],
  });
  await flush();

  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.sendMessage("Predict these items"), true);
  await flush();
  assert.equal(controller.snapshot.messages[0].text, "Predict these items");
  assert.equal(
    fetchStub.runs[0].body?.messages[0].content,
    "Predict these items",
  );
  assert.deepEqual(fetchStub.runs[0].body?.pageContext, {
    version: 1,
    app: "cockpit",
    surface: "cockpit.delivery-risk-list",
    entity: { kind: "purchase-order-item", id: "PO2-10" },
    selection: { itemIds: ["PO2-10"] },
  });
  controller.dispose();
});

test("host page context updates during an open chat and is snapshotted at send", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant(null, { contextScope: "page" });
  controller.setHostContext({
    version: 1,
    app: "cockpit",
    surface: "cockpit.overview",
  });
  await flush();

  controller.setHostContext({
    version: 1,
    app: "cockpit",
    surface: "cockpit.delivery-risk-detail",
    caseID: "delivery:4500000001/10",
  });
  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.sendMessage("Explain this case"), true);
  await flush();

  assert.equal(
    fetchStub.runs[0].body?.messages[0].content,
    "Explain this case",
  );
  assert.deepEqual(fetchStub.runs[0].body?.pageContext, {
    version: 1,
    app: "cockpit",
    surface: "cockpit.delivery-risk-detail",
    entity: { kind: "case", id: "delivery:4500000001/10" },
  });
  assert.equal(
    controller.snapshot.pageContext?.surface,
    "cockpit.delivery-risk-detail",
  );
  controller.dispose();
});

test("deduplicates replayed tokens and notifies only successful tool results", async () => {
  const changed: Record<string, unknown>[] = [];
  const controller = new AssistantController("materials", (payload) =>
    changed.push(payload),
  );
  controller.openAssistant();
  await flush();

  fetchStub.queueRun([
    { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: "Hello" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "reply", delta: " world" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "tool-1",
      toolCallName: "save_material",
    },
    { type: "TOOL_CALL_END", toolCallId: "tool-1" },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "tool-1",
      content: JSON.stringify({ id: 1 }),
    },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("create material");
  await flush();

  assert.equal(controller.snapshot.messages[1].text, "Hello world");
  assert.equal(controller.snapshot.activities[0].state, "complete");
  assert.equal(changed.length, 1);
  assert.equal(controller.snapshot.generating, false);
  controller.dispose();
});

test("maps a run error to a buyer-readable recovery message", async () => {
  const controller = new AssistantController("materials");
  controller.openAssistant();
  await flush();

  fetchStub.queueRun([{ type: "RUN_ERROR", message: "boom" }]);
  controller.sendMessage("create material");
  await flush();

  assert.equal(
    controller.snapshot.messages.at(-1)?.text,
    "The response was interrupted. You can retry your last prompt.",
  );
  assert.equal(controller.snapshot.generating, false);
  controller.dispose();
});

test("retains confirmation until a response is sent", async () => {
  const controller = new AssistantController("materials");
  controller.openAssistant();
  await flush();

  fetchStub.queueRun([
    {
      type: "CUSTOM",
      name: "on_interrupt",
      rawEvent: { id: "action-1" },
      value: {
        summary: "Save?",
        calls: [{ id: "call-1", name: "save_material", args: {} }],
      },
    },
  ]);
  controller.sendMessage("save it");
  await flush();

  assert.equal(controller.snapshot.generating, false);
  assert.equal(
    controller.snapshot.pendingConfirmation?.pendingActionId,
    "action-1",
  );
  assert.deepEqual(controller.snapshot.pendingConfirmation?.calls, [
    { id: "call-1", name: "save_material", args: {} },
  ]);

  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.confirm(), true);
  assert.equal(controller.snapshot.pendingConfirmation?.submitting, true);
  await flush();
  assert.equal(controller.snapshot.pendingConfirmation, null);
  const resumeRun = fetchStub.runs.at(-1)!;
  assert.equal(resumeRun.body?.resume[0].interruptId, "action-1");
  assert.equal(resumeRun.body?.resume[0].status, "resolved");
  assert.deepEqual(resumeRun.body?.resume[0].payload, {
    approved_tool_call_ids: ["call-1"],
  });
  controller.dispose();
});

test("declining a confirmation resumes with no approved tool call IDs", async () => {
  const controller = new AssistantController("materials");
  controller.openAssistant();
  await flush();
  fetchStub.queueRun([
    {
      type: "CUSTOM",
      name: "on_interrupt",
      rawEvent: { id: "action-2" },
      value: {
        summary: "Create a material?",
        calls: [
          { id: "call-2", name: "save_material", args: { material: "M1" } },
        ],
      },
    },
  ]);
  controller.sendMessage("create it");
  await flush();

  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  assert.equal(controller.cancel(), true);
  await flush();
  assert.deepEqual(fetchStub.runs.at(-1)?.body?.resume[0].payload, {
    approved_tool_call_ids: [],
  });
  controller.dispose();
});

test("orders tool activity with its turn across sessions", async () => {
  const controller = new AssistantController("catalog");
  controller.openAssistant();
  await flush();
  const firstId = controller.snapshot.activeSessionId!;

  fetchStub.queueRun([
    {
      type: "TOOL_CALL_START",
      toolCallId: "lookup",
      toolCallName: "lookup_product",
    },
    { type: "TOOL_CALL_END", toolCallId: "lookup" },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "lookup",
      content: JSON.stringify({ count: 2 }),
    },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "first-reply", delta: "Result" },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("First question");
  await flush();

  const firstTurn = controller.snapshot.messages[0].turnId;
  assert.deepEqual(controller.snapshot.turnOrder, [firstTurn]);
  assert.equal(controller.snapshot.activities[0].turnId, firstTurn);
  assert.ok(
    controller.snapshot.messages[0].order <
      controller.snapshot.activities[0].order,
  );
  assert.ok(
    controller.snapshot.activities[0].order <
      controller.snapshot.messages[1].order,
  );

  controller.newConversation();
  await flush();
  fetchStub.queueRun([
    {
      type: "TOOL_CALL_START",
      toolCallId: "search",
      toolCallName: "search_product",
    },
    { type: "TOOL_CALL_END", toolCallId: "search" },
    { type: "TOOL_CALL_RESULT", toolCallId: "search", content: "{}" },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("Second question");
  await flush();
  assert.equal(
    controller.snapshot.messages.at(-1)?.turnId,
    controller.snapshot.activities[0].turnId,
  );
  assert.equal(controller.snapshot.activities[0].state, "complete");

  controller.selectSession(firstId);
  await flush();
  assert.deepEqual(
    controller.snapshot.messages.map((message) => message.text),
    ["First question", "Result"],
  );
  assert.equal(controller.snapshot.activities[0].state, "complete");
  assert.equal(controller.snapshot.historyUnavailable, false);
  controller.dispose();
});

test("marks reloaded titled sessions as partial history without reconnecting while closed", async () => {
  const original = new AssistantController(
    "catalog",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  original.openAssistant();
  await flush();
  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  original.sendMessage("Please check the order status");
  await flush();
  original.dispose();

  const restored = new AssistantController(
    "catalog",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  assert.equal(restored.snapshot.historyUnavailable, true);
  restored.newConversation();
  restored.selectSession(
    restored.snapshot.sessions.find(
      (session) => session.title === "A shorter title",
    )!.id,
  );
  assert.equal(restored.snapshot.historyUnavailable, true);
  restored.dispose();
});

test("renames and removes browser-local sessions without losing the active conversation", async () => {
  const controller = new AssistantController("catalog");
  controller.openAssistant();
  await flush();
  const originalId = controller.snapshot.activeSessionId!;
  controller.renameSession(originalId, "  Renamed locally  ");
  assert.equal(controller.snapshot.sessions[0].title, "Renamed locally");
  controller.newConversation();
  const currentId = controller.snapshot.activeSessionId!;
  controller.removeSession(originalId);
  assert.equal(controller.snapshot.activeSessionId, currentId);
  assert.equal(
    controller.snapshot.sessions.some((session) => session.id === originalId),
    false,
  );
  controller.removeSession(currentId);
  assert.notEqual(controller.snapshot.activeSessionId, currentId);
  assert.equal(
    controller.snapshot.sessions.some((session) => session.id === currentId),
    false,
  );
  controller.dispose();
});

test("uses a host-provided bearer token on production hosts", async () => {
  Object.assign(globalThis.window.location, {
    protocol: "https:",
    hostname: "example.com",
    host: "example.com",
  });
  let token = "jwt-token";
  const controller = new AssistantController("catalog", undefined, () => token);
  controller.openAssistant();
  await flush();
  assert.equal(controller.snapshot.connected, true);

  controller.closeAssistant();
  token = "refreshed-token";
  controller.openAssistant();
  await flush();
  assert.equal(controller.snapshot.connected, true);
  controller.dispose();
});

test("a question passed to openAssistant is seeded, not sent, until Send (P-9)", async () => {
  const controller = new AssistantController("cockpit");
  fetchStub.queueRun([
    { type: "RUN_STARTED" },
    { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "Because" },
    { type: "TEXT_MESSAGE_END", messageId: "a1" },
    { type: "RUN_FINISHED" },
  ]);
  controller.openAssistant(
    {
      title: "Buyer cockpit",
      findingID: "at_risk:4500000001/10",
      itemIDs: ["4500000001/10"],
    },
    { message: "  Why is PO item 4500000001/10 listed?  " },
  );
  await flush();
  await flush();

  assert.equal(fetchStub.runs.length, 0, "opening makes no chat call");
  assert.equal(
    controller.snapshot.draft,
    "Why is PO item 4500000001/10 listed?",
  );
  assert.equal(
    controller.snapshot.contextLabel,
    "At risk · PO 4500000001 · item 10",
  );
  assert.equal(controller.takeDraft(), "Why is PO item 4500000001/10 listed?");
  assert.equal(controller.snapshot.draft, null);

  assert.equal(
    controller.sendMessage("Why is PO item 4500000001/10 listed?"),
    true,
  );
  await flush();
  assert.equal(fetchStub.runs.length, 1);
  assert.equal(
    fetchStub.runs[0].body?.messages[0].content,
    "Why is PO item 4500000001/10 listed?",
  );
  assert.deepEqual(fetchStub.runs[0].body?.pageContext, {
    version: 1,
    app: "cockpit",
    surface: "cockpit.overview",
    entity: { kind: "finding", id: "at_risk:4500000001/10" },
    selection: { itemIds: ["4500000001/10"] },
  });
  assert.equal(
    controller.snapshot.contextLabel,
    null,
    "the row context goes with one message",
  );
  assert.equal(controller.snapshot.pageContext, null);
  controller.openAssistant({ title: "Buyer cockpit" });
  await flush();
  assert.equal(fetchStub.runs.length, 1, "reopening does not send");
  controller.dispose();
});

test("a contextual question can start a fresh conversation", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant();
  await flush();
  const originalSession = controller.snapshot.activeSessionId;

  controller.openAssistant(
    { title: "Buyer cockpit", findingID: "freetext:0006522/00010" },
    { message: "Why is this listed?", newConversation: true },
  );
  await flush();

  assert.notEqual(controller.snapshot.activeSessionId, originalSession);
  assert.equal(controller.snapshot.draft, "Why is this listed?");
  assert.equal(
    controller.snapshot.contextLabel,
    "Free-text request · PR 0006522 · item 00010",
  );
  controller.dispose();
});

test("typed prevention case context has a buyer-readable label", () => {
  assert.equal(
    contextLabelOf({ caseID: "price:4500000001/10" }),
    "Price deviation · 4500000001/10",
  );
});

test("sends a message right away only with send: true", async () => {
  const controller = new AssistantController("cockpit");
  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  controller.openAssistant(
    { title: "Buyer cockpit" },
    { message: "Hi", send: true },
  );
  await flush();
  await flush();
  assert.equal(fetchStub.runs.length, 1);
  assert.equal(controller.snapshot.draft, null);
  controller.dispose();
});

test("drops a queued message when the assistant closes before connecting", async () => {
  fetchStub.healthy = false;
  const controller = new AssistantController("cockpit");
  controller.openAssistant(null, { message: "Why?", send: true });
  await flush();
  controller.closeAssistant();
  fetchStub.healthy = true;
  controller.openAssistant(null);
  await flush();
  assert.equal(fetchStub.runs.length, 0);
  controller.dispose();
});

test("surfaces bounded reconnect progress and preserves an edited draft", async () => {
  fetchStub.healthy = false;
  const controller = new AssistantController("cockpit");
  controller.openAssistant(null, { draft: "Keep this edited draft" });
  await flush();

  assert.equal(controller.snapshot.connection.phase, "reconnecting");
  assert.equal(controller.snapshot.connection.attempt, 1);
  assert.equal(controller.snapshot.connection.maxAttempts, 3);
  assert.equal(controller.takeDraft(), "Keep this edited draft");
  controller.dispose();
});

test("manual retry returns an unavailable connection to ready", async () => {
  fetchStub.healthy = false;
  const controller = new AssistantController("cockpit");
  controller.openAssistant();
  await flush();
  assert.equal(controller.snapshot.connection.phase, "reconnecting");

  fetchStub.healthy = true;
  controller.retryConnection();
  await flush();
  assert.equal(controller.snapshot.connection.phase, "ready");
  assert.equal(controller.snapshot.connected, true);
  controller.dispose();
});

test("reconnects to a thread with tool calls after reload and sends the queued message", async () => {
  const original = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  original.openAssistant();
  await flush();
  fetchStub.queueRun([
    {
      type: "TOOL_CALL_START",
      toolCallId: "t1",
      toolCallName: "list_po_items",
    },
    { type: "TOOL_CALL_END", toolCallId: "t1" },
    { type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "{}" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "r1", delta: "Done" },
    { type: "RUN_FINISHED" },
  ]);
  original.sendMessage("Show late items");
  await flush();
  const threadId = original.snapshot.activeSessionId;
  original.dispose();

  const reloaded = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  fetchStub.queueRun([{ type: "RUN_FINISHED" }]);
  reloaded.openAssistant(
    { title: "Buyer cockpit" },
    { message: "Why?", send: true },
  );
  try {
    await flush();
    await flush();

    assert.equal(reloaded.snapshot.activeSessionId, threadId);
    assert.equal(reloaded.snapshot.connected, true);
    assert.equal(reloaded.snapshot.activities[0].tool, "list_po_items");
    assert.deepEqual(reloaded.snapshot.activities[0].argsSummary, { q: "x" });
    assert.equal(reloaded.snapshot.activities[0].state, "complete");
    assert.equal(fetchStub.runs.length, 2);
    assert.equal(fetchStub.runs[1].body?.threadId, threadId);
    assert.match(fetchStub.runs[1].body?.messages[0].content, /^Why\?/);
  } finally {
    reloaded.dispose();
  }
});

test("completes an activity on TOOL_CALL_RESULT, once", async () => {
  const changed: Record<string, unknown>[] = [];
  const controller = new AssistantController("cockpit", (payload) =>
    changed.push(payload),
  );
  controller.openAssistant();
  await flush();

  fetchStub.queueRun([
    { type: "TOOL_CALL_START", toolCallId: "r1", toolCallName: "listRuns" },
    { type: "TOOL_CALL_END", toolCallId: "r1" },
    { type: "TOOL_CALL_RESULT", toolCallId: "r1", content: '{"count":3}' },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "Three runs." },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [{ id: "t", role: "tool", toolCallId: "r1", content: "{}" }],
    },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("runs?");
  await flush();

  const [activity] = controller.snapshot.activities;
  assert.equal(activity.state, "complete");
  assert.deepEqual(activity.summary, { count: 3 });
  assert.equal(changed.length, 1);
  controller.dispose();
});

test("completes activities from MESSAGES_SNAPSHOT and marks calls without a result unverified at RUN_FINISHED", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant();
  await flush();

  fetchStub.queueRun([
    { type: "TOOL_CALL_START", toolCallId: "s1", toolCallName: "listRuns" },
    { type: "TOOL_CALL_END", toolCallId: "s1" },
    { type: "TOOL_CALL_START", toolCallId: "s2", toolCallName: "getRun" },
    { type: "TOOL_CALL_END", toolCallId: "s2" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "Done." },
    {
      type: "MESSAGES_SNAPSHOT",
      messages: [
        { id: "u", role: "user", content: "runs?" },
        { id: "t", role: "tool", toolCallId: "s1", content: '{"n":1}' },
      ],
    },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("runs?");
  await flush();

  const [fromSnapshot, unverified] = controller.snapshot.activities;
  assert.equal(fromSnapshot.state, "complete");
  assert.deepEqual(fromSnapshot.summary, { n: 1 });
  assert.equal(unverified.state, "error");
  assert.equal(unverified.text, "Outcome not verified");
  assert.equal(controller.snapshot.generating, false);
  controller.dispose();
});

test("keeps a call awaiting approval open and completes it after the resume", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant();
  await flush();

  fetchStub.queueRun([
    { type: "TOOL_CALL_START", toolCallId: "w1", toolCallName: "predict" },
    { type: "TOOL_CALL_END", toolCallId: "w1" },
    {
      type: "CUSTOM",
      name: "on_interrupt",
      rawEvent: { id: "i1" },
      value: { summary: "Predict?", calls: [{ id: "w1", name: "predict" }] },
    },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("predict");
  await flush();
  assert.equal(controller.snapshot.activities[0].state, "started");

  fetchStub.queueRun([
    { type: "TOOL_CALL_RESULT", toolCallId: "w1", content: '{"ok":true}' },
    { type: "RUN_FINISHED" },
  ]);
  controller.confirm();
  await flush();
  assert.equal(controller.snapshot.activities[0].state, "complete");
  assert.deepEqual(controller.snapshot.activities[0].summary, { ok: true });
  controller.dispose();
});

test("a failed tool call is shown as failed, live and after a reload", async () => {
  const controller = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  controller.openAssistant();
  await flush();
  fetchStub.queueRun([
    {
      type: "TOOL_CALL_START",
      toolCallId: "f1",
      toolCallName: "lead_time_range",
    },
    { type: "TOOL_CALL_END", toolCallId: "f1" },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "f1",
      status: "error",
      content:
        "Error calling lead_time_range: leadTimeRange is not available yet in this cockpit (not implemented yet)",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "a",
      delta: "Not available yet.",
    },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("range?");
  await flush();
  const [activity] = controller.snapshot.activities;
  assert.equal(activity.state, "error");
  assert.match(activity.text, /not implemented yet/);
  assert.ok(
    controller.snapshot.messages.some(
      (m) => m.role === "error" && /not implemented yet/.test(m.text),
    ),
  );
  const threadId = controller.snapshot.activeSessionId;
  controller.dispose();

  // After a reload the thread history carries `error` on the tool message.
  const original = fetchStub.fetch;
  fetchStub.fetch = async (url: string, init?: RequestInit) => {
    const res = await original(url, init);
    if (!url.includes("/threads/")) return res;
    const body = await res.json();
    for (const m of body.messages) if (m.role === "tool") m.error = "error";
    return new Response(JSON.stringify(body), { status: 200 });
  };
  Object.assign(globalThis, { fetch: fetchStub.fetch });
  const reloaded = new AssistantController(
    "cockpit",
    undefined,
    undefined,
    undefined,
    "buyerD01",
  );
  reloaded.openAssistant();
  await flush();
  await flush();
  assert.equal(reloaded.snapshot.activeSessionId, threadId);
  assert.equal(reloaded.snapshot.activities[0].state, "error");
  reloaded.dispose();
});

test("a result card arrives with its tool result and end-of-turn notes are added", async () => {
  const controller = new AssistantController("cockpit");
  controller.openAssistant();
  await flush();
  const card = {
    kind: "prediction",
    ID: "q1",
    verdict: "pass",
    rows: [{ rank: 1 }],
  };
  fetchStub.queueRun([
    {
      type: "TOOL_CALL_START",
      toolCallId: "p1",
      toolCallName: "predict_orders",
    },
    { type: "TOOL_CALL_END", toolCallId: "p1" },
    {
      type: "TOOL_CALL_RESULT",
      toolCallId: "p1",
      status: "success",
      content: "{}",
      artifact: { card },
    },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "Reality check: …" },
    {
      type: "CUSTOM",
      name: "tide.turn",
      value: { messageId: "a", append: "No action was prepared." },
    },
    { type: "RUN_FINISHED" },
  ]);
  controller.sendMessage("which will be late?");
  await flush();
  const [c] = controller.snapshot.cards;
  assert.equal(c.kind, "prediction");
  assert.equal(c.data.ID, "q1");
  assert.equal(c.turnId, controller.snapshot.activities[0].turnId);
  const note = controller.snapshot.messages.find((m) => m.role === "note");
  assert.equal(note?.text, "No action was prepared.");
  controller.dispose();
});
