import AssistantClient, {
  type ConnectionState,
  type FailureCategory,
  type ServerEnvelope,
  type SessionSummary,
  type ThreadHistory,
} from "./AssistantClient";
import type { AssistantPageContextV1, AssistantSurface } from "./context";

/** Parses AG-UI `function.arguments` (a JSON string) into an args object. */
function parseToolArgs(
  raw: string | null | undefined,
): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface PageContext {
  title?: string;
  version?: 1;
  app?: "cockpit";
  surface?: AssistantSurface;
  entity?: AssistantPageContextV1["entity"];
  selection?: AssistantPageContextV1["selection"];
  filters?: AssistantPageContextV1["filters"];
  [key: string]: unknown;
}

export interface OpenOptions {
  /**
   * A question for the page context ("Why?" on a row). Put into the input,
   * not sent (P-9: the model runs only when the user presses Send), unless
   * `send` is true.
   */
  message?: string;
  /** Send `message` right away once connected and idle (programmatic use only). */
  send?: boolean;
  opener?: HTMLElement | null;
  /**
   * Put into the input, not sent: the user edits and sends it ("Why?" on a
   * row). Nothing reaches the agent until Send.
   */
  draft?: string;
  /** Short label of the row the question is about, shown above the input. */
  contextLabel?: string;
  /** Start a fresh conversation before opening; used by contextual "Why?" actions. */
  newConversation?: boolean;
  /** `once` applies direct row context to one message; `page` makes it persistent. */
  contextScope?: "once" | "page";
}

/** A result card of a tool call (e.g. `kind: "prediction"`). */
export interface AssistantCard {
  id: string;
  turnId: string;
  order: number;
  toolCallId: string;
  kind: string;
  data: Record<string, any>;
}

export interface AssistantMessage {
  id: string;
  turnId: string;
  order: number;
  role: "user" | "assistant" | "error" | "note";
  text: string;
  time: number;
}

export interface AssistantActivity {
  id: string;
  turnId: string;
  order: number;
  tool: string;
  argsSummary?: Record<string, unknown>;
  state: "started" | "complete" | "error" | "declined";
  text: string;
  summary?: Record<string, unknown>;
  time: number;
}

export interface PendingConfirmation {
  pendingActionId: string;
  tool: string;
  proposal?: Record<string, unknown>;
  calls: Array<{
    id: string;
    name: string;
    args?: Record<string, unknown>;
  }>;
  submitting: boolean;
}

export function approvalActionLabel(tool: string, target?: unknown): string {
  if (tool === "predict_orders") {
    if (target === "late_by_days") return "Predict lateness";
    if (target === "partial_delivery") return "Predict partial delivery";
    if (target !== "lead_time_days") return "Predict orders";
  }
  if (tool === "start_lead_time_prediction" || tool === "predict_orders")
    return "Predict lead time";
  return tool
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export interface AssistantState {
  connected: boolean;
  connection: ConnectionState;
  isOpen: boolean;
  generating: boolean;
  messages: AssistantMessage[];
  activities: AssistantActivity[];
  turnOrder: string[];
  historyUnavailable: boolean;
  historyLoading: boolean;
  canRetryLastPrompt: boolean;
  pendingConfirmation: PendingConfirmation | null;
  pageContext: PageContext | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  cards: AssistantCard[];
  /** Text to put into the input once (then cleared by the view). */
  draft: string | null;
  /** Label of the row the next message is about (with its page context). */
  contextLabel: string | null;
}

/** Buyer-readable label of the row a page context is about, if any. */
export function contextLabelOf(
  context: PageContext | null | undefined,
): string | null {
  if (!context) return null;
  if (context.entity && typeof context.entity.id === "string") {
    const labels: Record<string, string> = {
      case: "Case",
      finding: "Finding",
      "purchase-order-item": "PO item",
      customer: "Customer",
    };
    return `${labels[context.entity.kind] ?? "Context"} · ${context.entity.id}`;
  }
  if (typeof context.findingLabel === "string" && context.findingLabel)
    return context.findingLabel;
  if (typeof context.caseID === "string" && context.caseID) {
    const [kind, reference] = context.caseID.split(":", 2);
    const labels: Record<string, string> = {
      price: "Price deviation",
      duplicate: "Duplicate material",
      unusual_setting: "Unusual setting",
      supplier_planned_time: "Supplier planned time",
      material_planned_time: "Material planned time",
    };
    return labels[kind]
      ? `${labels[kind]}${reference ? ` · ${reference}` : ""}`
      : context.caseID;
  }
  if (typeof context.findingID === "string" && context.findingID) {
    const [list, objectKey] = context.findingID.split(":", 2);
    const [document, item] = objectKey?.split("/", 2) ?? [];
    const documentLabel = document
      ? `PO ${document}${item ? ` · item ${item}` : ""}`
      : objectKey;
    if (list === "freetext")
      return documentLabel
        ? `Free-text request · PR ${document}${item ? ` · item ${item}` : ""}`
        : "Free-text request";
    const listLabels: Record<string, string> = {
      at_risk: "At risk",
      overdue: "Overdue",
      price: "Price variance",
      duplicate: "Duplicate request",
      rare: "Unusual request",
      pdt: "Planned delivery time",
      mm_pdt: "Material delivery time",
    };
    return listLabels[list] && documentLabel
      ? `${listLabels[list]} · ${documentLabel}`
      : context.findingID.replace(":", " · ").replaceAll("_", " ");
  }
  const items = Array.isArray(context.itemIDs) ? context.itemIDs : [];
  if (items.length)
    return (
      items.slice(0, 3).join(", ") +
      (items.length > 3 ? ` +${items.length - 3}` : "")
    );
  const surfaces: Record<string, string> = {
    "cockpit.overview": "Buyer cockpit overview",
    "cockpit.delivery-risk-list": "Delivery risks",
    "cockpit.delivery-risk-detail": "Delivery risk",
    "cockpit.open-item": "Purchase order item",
    "cockpit.prevention-list": "Prevention cases",
    "cockpit.prevention-case": "Prevention case",
    "cockpit.customer-detail": "Customer impact",
    "cockpit.approvals": "Approvals",
    "cockpit.requests": "Requests",
    "cockpit.planning": "Planning",
    "cockpit.proof": "Proof",
    "cockpit.help": "Cockpit help",
  };
  return typeof context.surface === "string"
    ? (surfaces[context.surface] ?? context.title ?? null)
    : (context.title ?? null);
}

export class AssistantController {
  private state: AssistantState = {
    connected: false,
    connection: {
      phase: "unavailable",
      attempt: 0,
      maxAttempts: 3,
      retrying: false,
    },
    isOpen: false,
    generating: false,
    messages: [],
    activities: [],
    turnOrder: [],
    historyUnavailable: false,
    historyLoading: false,
    canRetryLastPrompt: false,
    pendingConfirmation: null,
    pageContext: null,
    sessions: [],
    activeSessionId: null,
    cards: [],
    draft: null,
    contextLabel: null,
  };
  private readonly client: AssistantClient;
  private readonly listeners = new Set<(state: AssistantState) => void>();
  private readonly sessionStates = new Map<
    string,
    {
      messages: AssistantMessage[];
      activities: AssistantActivity[];
      cards: AssistantCard[];
      turnOrder: string[];
      generating: boolean;
      historyUnavailable: boolean;
      pendingConfirmation: PendingConfirmation | null;
      activeTurnId: string | null;
    }
  >();
  private activeTurnId: string | null = null;
  private lastInterruptedPrompt: { id: string; text: string } | null = null;
  private queuedMessage: string | null = null;
  private pageContext: PageContext | null = null;
  private oneTurnContext: PageContext | null = null;
  private hostContextSuppressed = false;
  private nextOrder = 0;

  constructor(
    appId: string,
    private readonly onDataChanged?: (payload: Record<string, unknown>) => void,
    getToken?: () => string,
    agentUrl?: string,
    userId?: string,
  ) {
    this.client = new AssistantClient({
      appId,
      userId,
      onConnectionChange: (connection) =>
        this.update({
          connected: connection.phase === "ready",
          connection,
          historyUnavailable:
            connection.phase === "unavailable" &&
            this.state.messages.length === 0 &&
            this.state.sessions.some(
              (session) =>
                session.id === this.client.conversationId &&
                session.title !== "New conversation",
            ),
        }),
      onEnvelope: (envelope) => this.handleEnvelope(envelope),
      onHistoryLoading: (historyLoading) => this.update({ historyLoading }),
      onHistory: (history) => this.restoreHistory(history),
      shouldReconnect: () => this.state.isOpen,
      getToken,
      agentUrl,
    });
    this.state.historyUnavailable = this.client
      .listSessions()
      .some(
        (session) =>
          session.id === this.client.conversationId &&
          session.title !== "New conversation",
      );
  }

  get snapshot(): AssistantState {
    return this.state;
  }

  subscribe(listener: (state: AssistantState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Opens the panel; with `options.message`, also sends that message
   * (after connecting and after any running turn or open confirmation). */
  openAssistant(pageContext?: PageContext | null, options?: OpenOptions): void {
    if (options?.newConversation) this.newConversation();
    const scope = options?.contextScope ?? "once";
    if (scope === "page") {
      if (pageContext) this.pageContext = pageContext;
      this.oneTurnContext = null;
    } else {
      this.oneTurnContext = pageContext ?? null;
    }
    const message = options?.message?.trim();
    if (message && options?.send) this.queuedMessage = message;
    const draft =
      options?.draft?.trim() ?? (options?.send ? undefined : message);
    const effectiveContext = this.effectiveContext();
    this.update({
      isOpen: true,
      pageContext: effectiveContext,
      contextLabel:
        options?.contextLabel?.trim() ||
        contextLabelOf(this.oneTurnContext ?? effectiveContext),
      ...(draft ? { draft } : {}),
    });
    if (!this.state.connected) this.client.connect();
    this.refreshSessions();
  }

  /** Updates host-owned context. A direct one-turn context remains higher priority. */
  setHostContext(pageContext: PageContext | null): void {
    if (
      this.hostContextSuppressed &&
      JSON.stringify(pageContext) === JSON.stringify(this.pageContext)
    )
      return;
    this.hostContextSuppressed = false;
    this.pageContext = pageContext;
    if (!this.oneTurnContext) {
      this.update({
        pageContext,
        contextLabel: contextLabelOf(pageContext),
      });
    }
  }

  /** The view took the draft into its input. */
  takeDraft(): string | null {
    const draft = this.state.draft;
    if (draft !== null) this.update({ draft: null });
    return draft;
  }

  /** Drops the row context of the next message. */
  clearContext(): void {
    this.oneTurnContext = null;
    this.hostContextSuppressed = true;
    this.update({ contextLabel: null, pageContext: null });
  }

  private effectiveContext(): PageContext | null {
    if (this.oneTurnContext && this.pageContext)
      return { ...this.pageContext, ...this.oneTurnContext };
    return this.oneTurnContext ?? this.pageContext;
  }

  closeAssistant(): void {
    this.queuedMessage = null;
    this.update({
      isOpen: false,
      connected: false,
      connection: {
        ...this.state.connection,
        phase: "unavailable",
        retrying: false,
      },
    });
    this.client.disconnect();
  }

  dispose(): void {
    this.closeAssistant();
    this.listeners.clear();
  }

  newConversation(): void {
    this.saveSession();
    this.reset();
    this.client.newConversation();
    this.refreshSessions();
  }

  selectSession(id: string): void {
    if (id === this.client.conversationId) return;
    this.saveSession();
    this.reset();
    this.client.switchConversation(id);
    const saved = this.sessionStates.get(id);
    if (saved) {
      this.activeTurnId = saved.activeTurnId;
      this.update({
        messages: saved.messages,
        activities: saved.activities,
        cards: saved.cards,
        turnOrder: saved.turnOrder,
        generating: saved.generating,
        pendingConfirmation: saved.pendingConfirmation,
        historyUnavailable: saved.historyUnavailable,
      });
    } else {
      this.update({
        historyUnavailable: this.client
          .listSessions()
          .some(
            (session) =>
              session.id === id && session.title !== "New conversation",
          ),
      });
    }
    this.refreshSessions();
  }

  renameSession(id: string, title: string): void {
    this.client.renameSession(id, title);
    this.refreshSessions();
  }

  removeSession(id: string): void {
    if (id === this.client.conversationId) this.newConversation();
    this.client.removeSession(id);
    this.sessionStates.delete(id);
    this.refreshSessions();
  }

  sendMessage(text: string): boolean {
    const message = text.trim();
    if (
      !message ||
      !this.state.connected ||
      this.state.generating ||
      this.state.pendingConfirmation
    )
      return false;
    const messageId = crypto.randomUUID();
    const contextToSend = this.hostContextSuppressed
      ? null
      : (this.effectiveContext() ?? this.state.pageContext);
    if (!this.client.sendUserMessage(message, messageId, contextToSend))
      return false;
    const turnId = crypto.randomUUID();
    this.activeTurnId = turnId;
    const hadOneTurnContext = !!this.oneTurnContext;
    this.oneTurnContext = null;
    this.update({
      // Explicit row context is consumed by one successful message; host page
      // context remains active as navigation changes.
      contextLabel: hadOneTurnContext
        ? contextLabelOf(this.pageContext)
        : this.state.contextLabel,
      ...(hadOneTurnContext ? { pageContext: this.pageContext } : {}),
      generating: true,
      turnOrder: [...this.state.turnOrder, turnId],
      messages: [
        ...this.state.messages,
        {
          id: messageId,
          turnId,
          order: this.nextOrder++,
          role: "user",
          text: message,
          time: Date.now(),
        },
      ],
      canRetryLastPrompt: false,
    });
    this.refreshSessions();
    return true;
  }

  retryConnection(): void {
    this.client.connect();
  }

  signInAgain(): void {
    this.client.connect();
  }

  retryLastPrompt(): boolean {
    const lastUserMessage = [...this.state.messages]
      .reverse()
      .find((message) => message.role === "user");
    const prompt =
      this.lastInterruptedPrompt ??
      (lastUserMessage
        ? { id: lastUserMessage.id, text: lastUserMessage.text }
        : null);
    if (!prompt || !this.state.connected || this.state.generating) return false;
    if (
      !this.client.sendUserMessage(
        prompt.text,
        prompt.id,
        this.state.pageContext,
      )
    )
      return false;
    this.activeTurnId =
      this.state.messages.find((message) => message.id === prompt.id)?.turnId ??
      null;
    this.update({ generating: true, canRetryLastPrompt: false });
    return true;
  }

  confirm(): boolean {
    const id = this.state.pendingConfirmation?.pendingActionId;
    if (!id || !this.client.confirmAction(id)) return false;
    this.update({
      generating: true,
      pendingConfirmation: {
        ...this.state.pendingConfirmation!,
        submitting: true,
      },
    });
    return true;
  }

  cancel(): boolean {
    const id = this.state.pendingConfirmation?.pendingActionId;
    if (!id || !this.client.cancelAction(id)) return false;
    this.update({
      generating: true,
      pendingConfirmation: {
        ...this.state.pendingConfirmation!,
        submitting: true,
      },
    });
    return true;
  }

  private update(patch: Partial<AssistantState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
    this.sendQueued();
  }

  private sendQueued(): void {
    const message = this.queuedMessage;
    const { isOpen, connected, generating, pendingConfirmation } = this.state;
    if (!message || !isOpen || !connected || generating || pendingConfirmation)
      return;
    this.queuedMessage = null;
    this.sendMessage(message);
  }

  private reset(): void {
    this.activeTurnId = null;
    this.update({
      messages: [],
      activities: [],
      turnOrder: [],
      generating: false,
      pendingConfirmation: null,
      historyUnavailable: false,
      historyLoading: false,
      canRetryLastPrompt: false,
      cards: [],
    });
  }

  private saveSession(): void {
    this.sessionStates.set(this.client.conversationId, {
      messages: this.state.messages,
      activities: this.state.activities,
      cards: this.state.cards,
      turnOrder: this.state.turnOrder,
      generating: this.state.generating,
      historyUnavailable: this.state.historyUnavailable,
      pendingConfirmation: this.state.pendingConfirmation,
      activeTurnId: this.activeTurnId,
    });
  }

  private currentTurn(): string {
    if (!this.activeTurnId) {
      this.activeTurnId = crypto.randomUUID();
      this.update({ turnOrder: [...this.state.turnOrder, this.activeTurnId] });
    }
    return this.activeTurnId;
  }

  private refreshSessions(): void {
    this.update({
      sessions: this.client.listSessions(),
      activeSessionId: this.client.conversationId,
    });
  }

  private addMessage(role: AssistantMessage["role"], text: string): void {
    this.update({
      messages: [
        ...this.state.messages,
        {
          id: crypto.randomUUID(),
          turnId: this.currentTurn(),
          order: this.nextOrder++,
          role,
          text,
          time: Date.now(),
        },
      ],
    });
  }

  private restoreHistory(history: ThreadHistory): void {
    const messages: AssistantMessage[] = [];
    const activities: AssistantActivity[] = [];
    const cards: AssistantCard[] = [];
    const turnOrder: string[] = [];
    let turnId = "";
    let order = 0;
    for (const message of history.messages) {
      if (message.role === "user" || !turnId) {
        turnId = message.role === "user" ? message.id : crypto.randomUUID();
        turnOrder.push(turnId);
      }
      if (
        (message.role === "user" || message.role === "assistant") &&
        message.content
      ) {
        messages.push({
          id: message.id,
          turnId,
          order: order++,
          role: message.role,
          text: message.content,
          time: Date.now(),
        });
      }
      for (const call of message.toolCalls ?? []) {
        const tool = call.function?.name ?? call.name ?? "tool";
        activities.push({
          id: call.id,
          turnId,
          order: order++,
          tool,
          argsSummary: call.args ?? parseToolArgs(call.function?.arguments),
          state: "started",
          text: `Checking ${tool.replaceAll("_", " ")}…`,
          time: Date.now(),
        });
      }
      if (message.role === "tool") {
        const activity = activities.find(
          (item) => item.id === message.toolCallId,
        );
        if (activity) {
          const declined = message.content === "User declined this action.";
          activity.state = declined
            ? "declined"
            : message.error
              ? "error"
              : "complete";
          activity.text = declined
            ? "Declined"
            : message.error
              ? "Failed"
              : "Completed";
        }
        const card = history.artifacts?.[message.toolCallId ?? ""]?.card;
        if (card && message.toolCallId)
          cards.push(this.card(message.toolCallId, turnId, order++, card));
      }
    }
    this.nextOrder = order;
    this.activeTurnId = history.interrupt ? turnId : null;
    const pending = history.interrupt;
    this.update({
      messages,
      activities,
      cards,
      turnOrder,
      generating: false,
      historyUnavailable: false,
      historyLoading: false,
      pendingConfirmation: pending
        ? {
            pendingActionId: pending.id,
            tool: pending.value.calls[0]?.name ?? "action",
            proposal: pending.value,
            calls: pending.value.calls,
            submitting: false,
          }
        : null,
    });
  }

  private card(
    toolCallId: string,
    turnId: string,
    order: number,
    data: Record<string, any>,
  ): AssistantCard {
    return {
      id: `card-${toolCallId}`,
      turnId,
      order,
      toolCallId,
      kind: String(data.kind ?? "card"),
      data,
    };
  }

  private closeOpenActivities(_finished: boolean): AssistantActivity[] {
    if (this.state.pendingConfirmation) return this.state.activities;
    if (!this.state.activities.some((a) => a.state === "started"))
      return this.state.activities;
    return this.state.activities.map((activity) =>
      activity.state !== "started"
        ? activity
        : { ...activity, state: "error", text: "Outcome not verified" },
    );
  }

  private handleEnvelope({ type, payload = {} }: ServerEnvelope): void {
    switch (type) {
      case "token": {
        const turnId = this.currentTurn();
        const messageId = payload.messageId as string;
        const text = payload.text as string;
        const existing = this.state.messages.some(
          (message) => message.id === messageId,
        );
        this.update({
          messages: existing
            ? this.state.messages.map((message) =>
                message.id === messageId
                  ? { ...message, text: message.text + text }
                  : message,
              )
            : [
                ...this.state.messages,
                {
                  id: messageId,
                  turnId,
                  order: this.nextOrder++,
                  role: "assistant",
                  text,
                  time: Date.now(),
                },
              ],
        });
        break;
      }
      case "tool_call_started": {
        const turnId = this.currentTurn();
        const tool = payload.tool as string;
        this.update({
          activities: [
            ...this.state.activities,
            {
              id: payload.toolCallId as string,
              turnId,
              order: this.nextOrder++,
              tool,
              argsSummary: payload.argsSummary as
                Record<string, unknown> | undefined,
              state: "started",
              text: `Checking ${tool.replaceAll("_", " ")}…`,
              time: Date.now(),
            },
          ],
        });
        break;
      }
      case "sessions_updated":
        this.refreshSessions();
        break;
      case "tool_result": {
        const summary = payload.summary as Record<string, unknown> | undefined;
        const declined = summary?.message === "User declined this action.";
        const open = this.state.activities.some(
          (activity) =>
            activity.id === payload.toolCallId && activity.state === "started",
        );
        if (!open) break;
        this.update({
          activities: this.state.activities.map((activity) =>
            activity.id === payload.toolCallId && activity.state === "started"
              ? {
                  ...activity,
                  state: declined
                    ? "declined"
                    : payload.ok
                      ? "complete"
                      : "error",
                  text: declined
                    ? "Declined"
                    : payload.ok
                      ? "Completed"
                      : (summary?.message as string) || "Failed",
                  summary,
                }
              : activity,
          ),
        });
        const card = (payload.artifact as { card?: Record<string, any> })?.card;
        if (card) {
          const turnId =
            this.state.activities.find((a) => a.id === payload.toolCallId)
              ?.turnId ?? this.currentTurn();
          this.update({
            cards: [
              ...this.state.cards.filter(
                (c) => c.toolCallId !== payload.toolCallId,
              ),
              this.card(
                payload.toolCallId as string,
                turnId,
                this.nextOrder++,
                card,
              ),
            ],
          });
        }
        if (payload.ok && !declined) this.onDataChanged?.(payload);
        else if (!declined)
          this.addMessage(
            "error",
            (summary?.message as string) || "Tool call failed.",
          );
        break;
      }
      case "turn_check": {
        // End-of-turn checks of the agent: the streamed answer lacks them.
        const append = String(payload.append ?? "").trim();
        if (append) this.addMessage("note", append);
        break;
      }
      case "confirmation_required":
        this.update({
          generating: false,
          pendingConfirmation: {
            pendingActionId: payload.pendingActionId as string,
            tool: payload.tool as string,
            proposal: payload.proposal as Record<string, unknown> | undefined,
            calls:
              (payload.proposal as { calls?: PendingConfirmation["calls"] })
                ?.calls ?? [],
            submitting: false,
          },
        });
        break;
      case "error":
        if (payload.code === "interrupted") {
          const message = [...this.state.messages]
            .reverse()
            .find(
              (entry) =>
                entry.role === "user" && entry.turnId === this.activeTurnId,
            );
          if (message)
            this.lastInterruptedPrompt = { id: message.id, text: message.text };
        }
        this.update({ canRetryLastPrompt: payload.code === "interrupted" });
        this.addMessage(
          "error",
          this.failureMessage(payload.code as FailureCategory),
        );
        break;
      case "done":
        this.activeTurnId = null;
        this.update({
          generating: false,
          pendingConfirmation: this.state.pendingConfirmation?.submitting
            ? null
            : this.state.pendingConfirmation,
          activities: this.closeOpenActivities(payload.finished === true),
        });
        break;
    }
  }

  private failureMessage(category: FailureCategory | undefined): string {
    switch (category) {
      case "authentication":
        return "Your session has expired. Sign in again, then retry.";
      case "tool_failure":
        return "That action could not be completed. You can try again.";
      case "service_unavailable":
        return "The assistant service is temporarily unavailable. Your draft is safe.";
      default:
        return "The response was interrupted. You can retry your last prompt.";
    }
  }
}
