import {
  apiContext,
  type AssistantAppId,
  type AssistantPageContextV1,
} from "./context";

const STORAGE_PREFIX = "tide.assistant.conversation.";
const SESSIONS_PREFIX = "tide.assistant.sessions.";
const MAX_TITLE_LENGTH = 48;
const HEALTHCHECK_PATH = "/healthz";
const RUN_PATH = "/agent";
const MAX_RECONNECT_ATTEMPTS = 3;

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export type ConnectionPhase =
  "connecting" | "ready" | "reconnecting" | "unavailable";
export type FailureCategory =
  "service_unavailable" | "interrupted" | "authentication" | "tool_failure";

export interface ConnectionState {
  phase: ConnectionPhase;
  attempt: number;
  maxAttempts: number;
  retrying: boolean;
  lastError?: FailureCategory;
}

export interface ServerEnvelope {
  type: string;
  eventId?: number;
  conversationId?: string;
  payload?: Record<string, any>;
}

interface RunAgentMessage {
  id: string;
  role: "user";
  content: string;
}

interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: Record<string, unknown>;
}

interface RunAgentInput {
  threadId: string;
  runId: string;
  messages: RunAgentMessage[];
  pageContext?: AssistantPageContextV1;
  resume?: ResumeEntry[];
}

/** A tool call seen in the running turn (START, or a result for an earlier one). */
interface ToolCallBuffer {
  name: string;
  argsBuffer: string;
  resulted?: boolean;
}

interface PendingInterrupt {
  id: string;
  callIds: string[];
}

export interface ThreadHistory {
  pending_interrupt?: boolean;
  messages: Array<{
    id: string;
    role: string;
    content?: string | null;
    /**
     * AG-UI shape as the agent serialises it: `{id, type, function: {name,
     * arguments}}` with `arguments` a JSON string. The flat `{name, args}`
     * form is still accepted for tolerance.
     */
    toolCalls?: Array<{
      id: string;
      type?: string;
      function?: { name?: string; arguments?: string | null };
      name?: string;
      args?: Record<string, unknown>;
    }>;
    toolCallId?: string;
    /** Set on a failed tool result ("error"). */
    error?: string | null;
  }>;
  /** Result cards of tool calls (tool call ID -> {card}), see the agent's thread body. */
  artifacts?: Record<string, { card?: Record<string, unknown> } | null>;
  interrupt: {
    id: string;
    value: {
      summary?: string;
      calls: Array<{
        id: string;
        name: string;
        args?: Record<string, unknown>;
      }>;
    };
  } | null;
}

interface AssistantClientOptions {
  appId: string;
  userId?: string;
  onConnectionChange: (state: ConnectionState) => void;
  onEnvelope: (envelope: ServerEnvelope) => void;
  onHistoryLoading: (loading: boolean) => void;
  onHistory: (history: ThreadHistory) => void;
  shouldReconnect: () => boolean;
  getToken?: () => string;
  /** Agent origin, e.g. `http://localhost:8081`; empty = same origin. */
  agentUrl?: string;
}

interface PersistedSession {
  conversationId: string;
}

function normalizeInterrupt(
  id: unknown,
  value: unknown,
): NonNullable<ThreadHistory["interrupt"]> {
  const proposal = typeof value === "string" ? JSON.parse(value) : value;
  if (
    typeof id !== "string" ||
    !id ||
    id.length > 128 ||
    !proposal ||
    typeof proposal !== "object" ||
    !Array.isArray(proposal.calls) ||
    proposal.calls.length === 0 ||
    proposal.calls.length > 256
  )
    throw new Error("Invalid approval interrupt");
  const calls = proposal.calls.map((call: Record<string, unknown>) => {
    const callId = call?.id ?? call?.toolCallId;
    if (
      typeof callId !== "string" ||
      !callId ||
      callId.length > 256 ||
      typeof call?.name !== "string" ||
      !call.name ||
      call.name.length > 256 ||
      (call.args !== undefined &&
        (!call.args ||
          typeof call.args !== "object" ||
          Array.isArray(call.args)))
    )
      throw new Error("Invalid approval call");
    return {
      id: callId,
      name: call.name,
      args: call.args as Record<string, unknown> | undefined,
    };
  });
  if (
    new Set(calls.map((call: { id: string }) => call.id)).size !== calls.length
  )
    throw new Error("Duplicate approval calls");
  return {
    id,
    value: {
      summary:
        typeof proposal.summary === "string" ? proposal.summary : undefined,
      calls,
    },
  };
}

/**
 * HTTP/SSE client for tide-agent's AG-UI transport (`POST /agent`, `GET /healthz`).
 * Maps wire events to the assistant's token, tool, confirmation, error, and completion envelopes.
 */
export default class AssistantClient {
  private readonly _appId: string;
  private readonly _appContextId: AssistantAppId | null;
  private readonly _storageKey: string;
  private readonly _sessionsKey: string;
  private readonly _onConnectionChange: (state: ConnectionState) => void;
  private readonly _onEnvelope: (envelope: ServerEnvelope) => void;
  private readonly _onHistoryLoading: (loading: boolean) => void;
  private readonly _onHistory: (history: ThreadHistory) => void;
  private readonly _shouldReconnect: () => boolean;
  private readonly _getToken?: () => string;
  private readonly _agentUrl: string;
  private _connected = false;
  private _reconnectAttempt = 0;
  private _reconnectTimer: number | undefined;
  private _abortController: AbortController | null = null;
  private _pendingInterrupt: PendingInterrupt | null = null;
  private _connectionVersion = 0;
  private _conversationId!: string;
  private _sessions: SessionSummary[];

  constructor({
    appId,
    userId,
    onConnectionChange,
    onEnvelope,
    onHistoryLoading,
    onHistory,
    shouldReconnect,
    getToken,
    agentUrl = "",
  }: AssistantClientOptions) {
    this._appId = appId;
    this._appContextId = appId === "cockpit" ? appId : null;
    const identity = userId
      ? `${encodeURIComponent(appId)}:${encodeURIComponent(userId)}`
      : "";
    this._storageKey = identity ? `${STORAGE_PREFIX}${identity}` : "";
    this._sessionsKey = identity ? `${SESSIONS_PREFIX}${identity}` : "";
    this._onConnectionChange = onConnectionChange;
    this._onEnvelope = onEnvelope;
    this._onHistoryLoading = onHistoryLoading;
    this._onHistory = onHistory;
    this._shouldReconnect = shouldReconnect;
    this._getToken = getToken;
    this._agentUrl = agentUrl.replace(/\/+$/, "");
    try {
      window.localStorage.removeItem(`${STORAGE_PREFIX}${appId}`);
      window.localStorage.removeItem(`${SESSIONS_PREFIX}${appId}`);
    } catch {}
    this._restoreSession();
    this._sessions = this._loadSessions();
    this._ensureCurrentSessionListed();
    this._persistSession();
  }

  get conversationId(): string {
    return this._conversationId;
  }

  connect(): void {
    window.clearTimeout(this._reconnectTimer);
    this._reconnectAttempt = 0;
    this._emitConnection({ phase: "connecting", attempt: 0, retrying: false });
    void this._probeConnection();
  }

  disconnect(): void {
    window.clearTimeout(this._reconnectTimer);
    this._connectionVersion++;
    this._abortActiveTurn();
    this._connected = false;
  }

  newConversation(): void {
    this.switchConversation(crypto.randomUUID());
  }

  switchConversation(conversationId: string): void {
    this.disconnect();
    this._pendingInterrupt = null;
    this._conversationId = conversationId;
    this._persistSession();
    this._ensureCurrentSessionListed();
    if (this._shouldReconnect()) this.connect();
  }

  sendUserMessage(
    text: string,
    clientMessageId?: string,
    pageContext?: Record<string, unknown> | null,
  ): boolean {
    if (!this._connected || this._abortController || this._pendingInterrupt)
      return false;
    const context = this._appContextId
      ? apiContext(
          pageContext as
            AssistantPageContextV1 | Record<string, unknown> | null,
          this._appContextId,
        )
      : null;
    void this._runTurn({
      threadId: this._conversationId,
      runId: crypto.randomUUID(),
      messages: [
        {
          id: clientMessageId ?? crypto.randomUUID(),
          role: "user",
          content: text,
        },
      ],
      ...(context ? { pageContext: context } : {}),
    });
    if (this._touchSession(text)) void this._requestTitle(text);
    return true;
  }

  /** Sessions this browser has seen for this appId, most-recently-active first. */
  listSessions(): SessionSummary[] {
    return [...this._sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  renameSession(id: string, title: string): void {
    const session = this._sessions.find((item) => item.id === id);
    if (!session || !title.trim()) return;
    session.title = title.trim().slice(0, MAX_TITLE_LENGTH);
    this._saveSessions();
  }

  removeSession(id: string): void {
    if (id === this._conversationId) return;
    this._sessions = this._sessions.filter((item) => item.id !== id);
    this._saveSessions();
  }

  confirmAction(pendingActionId: string): boolean {
    if (
      !this._connected ||
      this._abortController ||
      !this._pendingInterrupt ||
      this._pendingInterrupt.id !== pendingActionId
    )
      return false;
    const approvedIds = this._pendingInterrupt.callIds;
    this._pendingInterrupt = null;
    void this._runTurn({
      threadId: this._conversationId,
      runId: crypto.randomUUID(),
      messages: [],
      resume: [
        {
          interruptId: pendingActionId,
          status: "resolved",
          payload: { approved_tool_call_ids: approvedIds },
        },
      ],
    });
    return true;
  }

  cancelAction(pendingActionId: string): boolean {
    if (
      !this._connected ||
      this._abortController ||
      !this._pendingInterrupt ||
      this._pendingInterrupt.id !== pendingActionId
    )
      return false;
    this._pendingInterrupt = null;
    void this._runTurn({
      threadId: this._conversationId,
      runId: crypto.randomUUID(),
      messages: [],
      resume: [
        {
          interruptId: pendingActionId,
          status: "resolved",
          payload: { approved_tool_call_ids: [] },
        },
      ],
    });
    return true;
  }

  private async _probeConnection(): Promise<void> {
    const version = ++this._connectionVersion;
    this._onHistoryLoading(true);
    try {
      const response = await fetch(`${this._baseUrl()}${HEALTHCHECK_PATH}`, {
        headers: this._authHeaders(),
      });
      if (!response.ok) throw this._httpFailure(response.status);
      const history = await fetch(
        `${this._baseUrl()}/threads/${encodeURIComponent(this._conversationId)}`,
        { headers: this._authHeaders() },
      );
      if (!history.ok) throw this._httpFailure(history.status);
      const snapshot = (await history.json()) as ThreadHistory;
      if (version !== this._connectionVersion) return;
      if (snapshot.pending_interrupt && !snapshot.interrupt)
        throw new Error("Approval history unavailable");
      if (snapshot.interrupt)
        snapshot.interrupt = normalizeInterrupt(
          snapshot.interrupt.id,
          snapshot.interrupt.value,
        );
      this._pendingInterrupt = snapshot.interrupt
        ? {
            id: snapshot.interrupt.id,
            callIds: snapshot.interrupt.value.calls.map((call) => call.id),
          }
        : null;
      this._onHistory(snapshot);
      this._reconnectAttempt = 0;
      this._connected = true;
      this._emitConnection({ phase: "ready", attempt: 0, retrying: false });
    } catch (error) {
      if (version !== this._connectionVersion) return;
      this._connected = false;
      this._scheduleReconnect(this._failureCategory(error));
    } finally {
      if (version === this._connectionVersion) this._onHistoryLoading(false);
    }
  }

  private _abortActiveTurn(): void {
    this._abortController?.abort();
    this._abortController = null;
  }

  private async _runTurn(input: RunAgentInput): Promise<void> {
    this._abortActiveTurn();
    const controller = new AbortController();
    this._abortController = controller;
    let terminated = false;
    const toolCallBuffers = new Map<string, ToolCallBuffer>();
    try {
      const response = await fetch(`${this._baseUrl()}${RUN_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tide-App-Id": this._appId,
          ...this._authHeaders(),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        if (controller.signal.aborted) return;
        this._connected = false;
        this._onEnvelope({
          type: "error",
          payload: {
            message: `Request failed (${response.status})`,
            code: "http_error",
          },
        });
        terminated = true;
        this._emitConnection({
          phase: "unavailable",
          attempt: this._reconnectAttempt,
          retrying: false,
          lastError: this._failureCategory(this._httpFailure(response.status)),
        });
        this._onEnvelope({ type: "done" });
        this._scheduleReconnect(
          this._failureCategory(this._httpFailure(response.status)),
        );
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted) return;
        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (this._dispatchSseChunk(chunk, toolCallBuffers)) {
            terminated = true;
            controller.abort();
            await reader.cancel();
            return;
          }
        }
        if (done) {
          if (buffer.trim() && this._dispatchSseChunk(buffer, toolCallBuffers))
            terminated = true;
          break;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      this._connected = false;
      if (this._abortController === controller) this._abortController = null;
      this._onEnvelope({
        type: "error",
        payload: { code: "interrupted" },
      });
      terminated = true;
      this._scheduleReconnect(this._failureCategory(err));
      this._onEnvelope({ type: "done" });
    } finally {
      if (!controller.signal.aborted && !terminated)
        this._onEnvelope({ type: "done" });
      if (this._abortController === controller) this._abortController = null;
    }
  }

  /**
   * At most one `tool_result` per call and run: MESSAGES_SNAPSHOT repeats the
   * results already streamed. Calls may have started in an earlier run (a
   * resumed approval); the controller ignores results for calls it has
   * already closed.
   */
  private _emitToolResult(
    toolCallId: string,
    content: unknown,
    toolCallBuffers: Map<string, ToolCallBuffer>,
    failed = false,
    artifact?: unknown,
  ): void {
    const pending = toolCallBuffers.get(toolCallId);
    if (pending?.resulted) return;
    if (pending) pending.resulted = true;
    else
      toolCallBuffers.set(toolCallId, {
        name: "tool",
        argsBuffer: "",
        resulted: true,
      });
    let summary: Record<string, unknown> | undefined;
    try {
      summary =
        typeof content === "string" && content
          ? JSON.parse(content)
          : undefined;
    } catch {
      summary = { message: content };
    }
    this._onEnvelope({
      type: "tool_result",
      payload: { toolCallId, ok: !failed, summary, artifact },
    });
  }

  private _receiveInterrupt(id: unknown, value: unknown): void {
    const interrupt = normalizeInterrupt(id, value);
    if (this._pendingInterrupt?.id === interrupt.id) return;
    this._pendingInterrupt = {
      id: interrupt.id,
      callIds: interrupt.value.calls.map((call) => call.id),
    };
    this._abortController?.abort();
    this._abortController = null;
    this._onEnvelope({
      type: "confirmation_required",
      payload: {
        pendingActionId: interrupt.id,
        tool: interrupt.value.calls[0].name,
        proposal: interrupt.value,
      },
    });
  }

  /** Parses one `data: {...}` SSE record and forwards it as a UI envelope. Returns true once a terminal (RUN_FINISHED/RUN_ERROR) event has been emitted. */
  private _dispatchSseChunk(
    chunk: string,
    toolCallBuffers: Map<string, ToolCallBuffer>,
  ): boolean {
    const dataLine = chunk.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return false;
    let event: Record<string, any>;
    try {
      event = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return false;
    }
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
        this._onEnvelope({
          type: "token",
          payload: { messageId: event.messageId, text: event.delta },
        });
        return false;
      case "TOOL_CALL_START":
        toolCallBuffers.set(event.toolCallId, {
          name: event.toolCallName,
          argsBuffer: "",
        });
        return false;
      case "TOOL_CALL_ARGS": {
        const pending = toolCallBuffers.get(event.toolCallId);
        if (pending) pending.argsBuffer += event.delta ?? "";
        return false;
      }
      case "TOOL_CALL_END": {
        const pending = toolCallBuffers.get(event.toolCallId);
        let argsSummary: Record<string, unknown> | undefined;
        try {
          argsSummary = pending?.argsBuffer
            ? JSON.parse(pending.argsBuffer)
            : undefined;
        } catch {
          argsSummary = undefined;
        }
        this._onEnvelope({
          type: "tool_call_started",
          payload: {
            toolCallId: event.toolCallId,
            tool: pending?.name ?? "tool",
            argsSummary,
          },
        });
        return false;
      }
      case "TOOL_CALL_RESULT":
        // `status` / `artifact` are extra fields of the tide agent.
        this._emitToolResult(
          event.toolCallId,
          event.content,
          toolCallBuffers,
          event.status === "error",
          event.artifact,
        );
        return false;
      case "MESSAGES_SNAPSHOT":
        // Fallback for a stream without TOOL_CALL_RESULT: the snapshot has
        // the tool messages of every call this run started.
        for (const message of event.messages ?? []) {
          if (message?.role === "tool" && message.toolCallId)
            this._emitToolResult(
              message.toolCallId,
              message.content,
              toolCallBuffers,
              !!message.error,
            );
        }
        return false;
      case "CUSTOM":
        if (event.name === "tide.turn") {
          this._onEnvelope({ type: "turn_check", payload: event.value ?? {} });
          return false;
        }
        if (event.name === "on_interrupt") {
          const proposal =
            typeof event.value === "string"
              ? JSON.parse(event.value)
              : event.value;
          const interruptId =
            event.rawEvent?.id ?? proposal?.id ?? proposal?.interruptId;
          this._receiveInterrupt(interruptId, proposal);
          return true;
        }
        return false;
      case "RUN_ERROR":
        this._onEnvelope({
          type: "error",
          payload: { message: event.message, code: event.code ?? "run_error" },
        });
        this._onEnvelope({ type: "done" });
        return true;
      case "RUN_FINISHED":
        if (event.outcome?.type === "interrupt") {
          if (
            !Array.isArray(event.outcome.interrupts) ||
            event.outcome.interrupts.length !== 1
          )
            throw new Error("Unsupported approval interrupt count");
          const interrupt = event.outcome.interrupts[0];
          this._receiveInterrupt(
            interrupt.id,
            interrupt.metadata?.langgraph?.raw,
          );
          return true;
        }
        this._onEnvelope({ type: "done", payload: { finished: true } });
        return true;
      default:
        return false;
    }
  }

  private _baseUrl(): string {
    return this._agentUrl;
  }

  /** Only the host supplies credentials; the library has no fallback. */
  private _token(): string {
    return this._getToken?.() ?? "";
  }

  private _authHeaders(): Record<string, string> {
    const token = this._token();
    if (!token) {
      return {};
    }
    return {
      Authorization: /^(Bearer|Basic)\s/i.test(token)
        ? token
        : `Bearer ${token}`,
    };
  }

  private _scheduleReconnect(lastError: FailureCategory): void {
    if (
      !this._shouldReconnect() ||
      this._reconnectAttempt >= MAX_RECONNECT_ATTEMPTS
    ) {
      this._emitConnection({
        phase: "unavailable",
        attempt: this._reconnectAttempt,
        retrying: false,
        lastError,
      });
      return;
    }
    const attempt = ++this._reconnectAttempt;
    this._emitConnection({
      phase: "reconnecting",
      attempt,
      retrying: true,
      lastError,
    });
    const delay = Math.min(3000 * 2 ** (attempt - 1), 30000);
    this._reconnectTimer = window.setTimeout(
      () => void this._probeConnection(),
      delay,
    );
  }

  private _emitConnection(state: Omit<ConnectionState, "maxAttempts">): void {
    this._onConnectionChange({ ...state, maxAttempts: MAX_RECONNECT_ATTEMPTS });
  }

  private _httpFailure(status: number): Error & { status: number } {
    return Object.assign(new Error(`HTTP ${status}`), { status });
  }

  private _failureCategory(error: unknown): FailureCategory {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) return "authentication";
    if (typeof status === "number" && status >= 500)
      return "service_unavailable";
    return "interrupted";
  }

  private _restoreSession(): void {
    if (!this._storageKey) {
      this._conversationId = crypto.randomUUID();
      return;
    }
    let saved: PersistedSession | null = null;
    try {
      saved = JSON.parse(
        window.localStorage.getItem(this._storageKey) || "null",
      );
    } catch {
      saved = null;
    }
    this._conversationId = saved?.conversationId || crypto.randomUUID();
  }

  private _loadSessions(): SessionSummary[] {
    if (!this._sessionsKey) return [];
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(this._sessionsKey) || "[]",
      );
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  private _saveSessions(): void {
    if (!this._sessionsKey) return;
    window.localStorage.setItem(
      this._sessionsKey,
      JSON.stringify(this._sessions),
    );
  }

  private _ensureCurrentSessionListed(): void {
    if (this._sessions.some((s) => s.id === this._conversationId)) return;
    this._sessions.unshift({
      id: this._conversationId,
      title: "New conversation",
      updatedAt: Date.now(),
    });
    this._saveSessions();
  }

  private _touchSession(latestText: string): boolean {
    const index = this._sessions.findIndex(
      (s) => s.id === this._conversationId,
    );
    const previous = this._sessions[index];
    const shouldGenerateTitle =
      !previous || previous.title === "New conversation";
    const title = shouldGenerateTitle
      ? this._fallbackTitle(latestText)
      : previous.title;
    const entry: SessionSummary = {
      id: this._conversationId,
      title,
      updatedAt: Date.now(),
    };
    if (index >= 0) this._sessions[index] = entry;
    else this._sessions.unshift(entry);
    this._saveSessions();
    return shouldGenerateTitle;
  }

  private async _requestTitle(text: string): Promise<void> {
    const fallback = this._fallbackTitle(text);
    const conversationId = this._conversationId;
    try {
      const response = await fetch(
        `${this._baseUrl()}/threads/${encodeURIComponent(conversationId)}/title`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tide-App-Id": this._appId,
            ...this._authHeaders(),
          },
          body: JSON.stringify({ text: text.slice(0, 1200) }),
        },
      );
      if (!response.ok) return;
      const body = (await response.json()) as { title?: unknown };
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return;
      const current = this._sessions.find((item) => item.id === conversationId);
      // Keep an explicit rename (or a newer message's fallback) over the
      // delayed response for the first message.
      if (!current || current.title !== fallback) return;
      current.title = title.slice(0, MAX_TITLE_LENGTH);
      this._saveSessions();
      this._onEnvelope({ type: "sessions_updated" });
    } catch {
      // A title is a convenience; the immediately saved message fallback stays.
    }
  }

  private _fallbackTitle(text: string): string {
    const firstLine = text.split(/\r?\n/, 1)[0].trim().replace(/\s+/g, " ");
    if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
    const shortened = firstLine
      .slice(0, MAX_TITLE_LENGTH)
      .replace(/\s+\S*$/, "");
    return `${shortened || firstLine.slice(0, MAX_TITLE_LENGTH).trim()}…`;
  }

  private _persistSession(): void {
    if (!this._storageKey) return;
    window.localStorage.setItem(
      this._storageKey,
      JSON.stringify({ conversationId: this._conversationId }),
    );
  }
}
