import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/TextArea.js";
import "@ui5/webcomponents-icons/dist/add.js";
import "@ui5/webcomponents-icons/dist/copy.js";
import "@ui5/webcomponents-icons/dist/decline.js";
import "@ui5/webcomponents-icons/dist/ai.js";
import "@ui5/webcomponents-icons/dist/edit.js";
import "@ui5/webcomponents-icons/dist/full-screen.js";
import "@ui5/webcomponents-icons/dist/menu2.js";
import "@ui5/webcomponents-icons/dist/minimize.js";
import "@ui5/webcomponents-icons/dist/paper-plane.js";
import "@ui5/webcomponents-icons/dist/search.js";
import "@ui5/webcomponents-icons/dist/thumb-up.js";
import "@ui5/webcomponents-icons/dist/thumb-down.js";
import "@ui5/webcomponents-icons/dist/refresh.js";
import "@ui5/webcomponents-icons/dist/hint.js";
import "@ui5/webcomponents-icons/dist/overflow.js";
import "@ui5/webcomponents-icons/dist/delete.js";
import type Button from "@ui5/webcomponents/dist/Button.js";
import type MessageStrip from "@ui5/webcomponents/dist/MessageStrip.js";
import type TextArea from "@ui5/webcomponents/dist/TextArea.js";
import {
  AssistantController,
  approvalActionLabel,
  type AssistantActivity,
  type AssistantState,
  type OpenOptions,
  type PageContext,
} from "./AssistantController";
import { renderMarkdown } from "./markdownDom";
import { renderCard } from "./PredictionCard";
import { activityHeader } from "./activity-label";
import {
  defaultPageContext,
  promptsForContext,
  type AssistantContextProvider,
  type AssistantPageContextV1,
} from "./context";

declare global {
  interface HTMLElementTagNameMap {
    "ui5-button": Button;
    "ui5-message-strip": MessageStrip;
    "ui5-textarea": TextArea;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(
  icon: string,
  label: string,
  action: () => void,
  className?: string,
): HTMLElement {
  const node = element("ui5-button", className);
  node.setAttribute("icon", icon);
  node.setAttribute("tooltip", label);
  node.setAttribute("accessible-name", label);
  node.addEventListener("click", action);
  return node;
}

export class TideAssistant extends HTMLElement {
  static get observedAttributes(): string[] {
    return ["app-id", "user-id", "agent-url", "hide-launcher"];
  }

  authToken = "";
  get userId(): string {
    return this.getAttribute("user-id") || "";
  }

  set userId(value: string) {
    if (value !== this.userId) this.setAttribute("user-id", value);
  }

  pageContextProvider?: () => PageContext | null;
  private controller?: AssistantController;
  private unsubscribe?: () => void;
  private unsubscribeContext?: () => void;
  private expanded = false;
  private opener: HTMLElement | null = null;
  private sidebarOpen = false;
  private launcher = button(
    "ai",
    "Ask TIDE",
    () => {
      const context =
        (this.contextProvider?.getContext() as PageContext | null) ??
        this.pageContextProvider?.() ??
        null;
      this.controller?.setHostContext(context);
      this.openAssistant(context, { contextScope: "page" });
    },
    "assistantLauncher",
  );
  private panel = element("aside", "assistantPanel");
  private sidebar = element("div", "assistantSidebar");
  private sidebarId = `assistant-conversations-${Math.random().toString(36).slice(2)}`;
  private sidebarList = element("div", "assistantSessionList");
  private sidebarSearch = element("input", "assistantSidebarSearch");
  private chatsGroupOpen = true;
  private sessionToggle = button("menu2", "Conversations", () => {
    this.sidebarOpen = !this.sidebarOpen;
    this.render(this.controller!.snapshot);
  });
  private messages = element("div", "assistantMessages");
  private headerLabel = element("span", "assistantHeaderLabel");
  private connection = element("ui5-message-strip");
  private connectionAction = button("refresh", "Retry connection", () =>
    this.controller?.retryConnection(),
  );
  private confirmation = element("div", "assistantConfirmation");
  private input = element("ui5-textarea");
  private send = button(
    "paper-plane",
    "Send",
    () => this.submit(),
    "assistantSendButton",
  );
  private expand = button("full-screen", "Expand", () => this.toggleExpanded());
  private draft = "";
  private contextChip = element("div", "assistantContextChip");
  private promptSuggestions = element("div", "assistantPromptSuggestions");
  private cardNodes = new Map<string, HTMLElement>();
  private messageNodes = new Map<string, HTMLElement>();
  private traceNodes = new Map<string, HTMLDetailsElement>();
  private feedback = new Map<string, "positive" | "negative">();
  private currentContextProvider?: AssistantContextProvider;

  set contextProvider(provider: AssistantContextProvider | undefined) {
    this.unsubscribeContext?.();
    this.unsubscribeContext = undefined;
    this.currentContextProvider = provider;
    if (provider && this.controller) {
      this.controller.setHostContext(
        (provider.getContext() as PageContext | null) ?? null,
      );
      this.unsubscribeContext = provider.subscribe?.(() => {
        this.controller?.setHostContext(
          (provider.getContext() as PageContext | null) ?? null,
        );
      });
    }
  }

  get contextProvider(): AssistantContextProvider | undefined {
    return this.currentContextProvider;
  }

  connectedCallback(): void {
    this.mount();
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeContext?.();
    this.unsubscribeContext = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  }

  attributeChangedCallback(
    name: string,
    previous: string | null,
    value: string | null,
  ): void {
    if (previous === value) return;
    if (name === "user-id") this.authToken = "";
    if (this.isConnected) this.mount();
  }

  /** Opens the panel. `options.message` (e.g. a "Why?" question for a row)
   * is put into the input with the row as context; it is sent only when the
   * user presses Send (hosts can detect support via `openAssistant.length >= 2`). */
  openAssistant(pageContext?: PageContext | null, options?: OpenOptions): void {
    this.opener = options?.opener ?? null;
    this.controller?.openAssistant(
      pageContext,
      options ?? { contextScope: "once" },
    );
    this.input.focus();
  }

  closeAssistant(): void {
    this.controller?.closeAssistant();
    (this.opener ?? this.launcher).focus();
    this.opener = null;
  }

  private mount(): void {
    this.unsubscribe?.();
    this.unsubscribeContext?.();
    this.unsubscribeContext = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.messageNodes.clear();
    this.traceNodes.clear();
    this.cardNodes.clear();
    this.feedback.clear();
    this.messages.replaceChildren();
    this.draft = "";
    this.input.value = "";
    this.sidebarSearch.value = "";
    this.sidebarOpen = false;
    this.opener = null;
    this.replaceChildren();
    const appId = this.getAttribute("app-id");
    if (!appId) return;
    this.controller = new AssistantController(
      appId,
      (payload) => {
        this.dispatchEvent(
          new CustomEvent("tide:assistant-data-changed", {
            bubbles: true,
            detail: payload,
          }),
        );
      },
      () => this.authToken,
      this.getAttribute("agent-url") ?? "",
      this.userId,
    );
    this.panel.setAttribute("role", "complementary");
    this.panel.setAttribute("aria-label", "TIDE");
    this.sidebar.id = this.sidebarId;
    this.sessionToggle.setAttribute("aria-controls", this.sidebarId);
    this.panel.onkeydown = (event) => {
      if (event.key === "Escape" && this.sidebarOpen) {
        event.preventDefault();
        this.closeSidebar();
      }
    };
    this.sidebar.setAttribute("role", "navigation");
    this.sidebar.setAttribute("aria-label", "Conversations");
    const sidebarToolbar = element("div", "assistantSidebarToolbar");
    this.sidebarSearch.type = "search";
    this.sidebarSearch.placeholder = "Search conversations";
    this.sidebarSearch.setAttribute("aria-label", "Search conversations");
    this.sidebarSearch.oninput = () =>
      this.renderSessions(this.controller!.snapshot);
    const searchRow = element("div", "assistantSidebarSearchRow");
    searchRow.hidden = true;
    searchRow.append(this.sidebarSearch);
    sidebarToolbar.append(
      button(
        "search",
        "Search conversations",
        () => {
          searchRow.hidden = !searchRow.hidden;
          if (searchRow.hidden) {
            this.sidebarSearch.value = "";
            this.renderSessions(this.controller!.snapshot);
          } else this.sidebarSearch.focus();
        },
        "assistantSidebarSearchToggle",
      ),
      button("add", "New conversation", () => {
        this.controller?.newConversation();
        if (window.matchMedia("(max-width: 899px)").matches)
          this.closeSidebar();
      }),
      button("decline", "Close conversations", () => this.closeSidebar()),
    );
    this.sidebar.replaceChildren(sidebarToolbar, searchRow, this.sidebarList);
    const main = element("div", "assistantMain");
    const header = element("div", "assistantHeader");
    const identity = element("div", "assistantHeaderIdentity");
    identity.append(this.headerLabel);
    header.append(this.sessionToggle, identity);
    const actions = element("div", "assistantHeaderActions");
    actions.append(
      button("add", "New conversation", () =>
        this.controller?.newConversation(),
      ),
      this.expand,
      button("decline", "Close", () => this.closeAssistant()),
    );
    header.append(actions);
    header
      .querySelectorAll("ui5-button")
      .forEach((control) => control.setAttribute("design", "Transparent"));
    sidebarToolbar
      .querySelectorAll("ui5-button")
      .forEach((control) => control.setAttribute("design", "Transparent"));
    this.connection.setAttribute("role", "status");
    this.connection.setAttribute("aria-live", "polite");
    this.connection.setAttribute("design", "Information");
    this.connection.setAttribute("hide-close-button", "");
    this.connection.classList.add("assistantConnection");
    const connectionRow = element("div", "assistantConnectionRow");
    connectionRow.append(this.connection, this.connectionAction);
    this.confirmation.replaceChildren();
    this.input.setAttribute("growing", "");
    this.input.setAttribute("growing-max-rows", "4");
    this.input.setAttribute("rows", "1");
    this.input.setAttribute("accessible-name", "Message");
    this.input.setAttribute("placeholder", "Message…");
    this.input.oninput = () => {
      this.draft = this.input.value;
      this.updateComposer(this.controller!.snapshot);
    };
    this.input.onkeydown = (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.submit();
      }
    };
    const inputRow = element("div", "assistantInputRow");
    inputRow.append(this.input, this.send);
    this.contextChip.hidden = true;
    main.append(
      connectionRow,
      this.messages,
      this.confirmation,
      this.contextChip,
      this.promptSuggestions,
      inputRow,
      element(
        "div",
        "assistantNotice",
        "AI-generated content may be incorrect.",
      ),
    );
    const body = element("div", "assistantBody");
    const backdrop = element("button", "assistantSidebarBackdrop");
    backdrop.type = "button";
    backdrop.setAttribute("aria-label", "Close conversations");
    backdrop.addEventListener("click", () => this.closeSidebar());
    body.append(this.sidebar, backdrop, main);
    this.panel.replaceChildren(header, body);
    this.append(this.launcher, this.panel);
    this.unsubscribe = this.controller.subscribe((state) => this.render(state));
    const initialContext =
      (this.contextProvider?.getContext() as PageContext | null) ??
      this.pageContextProvider?.() ??
      (defaultPageContext(appId) as PageContext | null);
    this.controller.setHostContext(initialContext);
    this.unsubscribeContext = this.contextProvider?.subscribe?.(() => {
      this.controller?.setHostContext(
        (this.contextProvider?.getContext() as PageContext | null) ?? null,
      );
    });
  }

  private toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.expand.setAttribute(
      "icon",
      this.expanded ? "minimize" : "full-screen",
    );
    this.expand.setAttribute("tooltip", this.expanded ? "Collapse" : "Expand");
    this.expand.setAttribute(
      "accessible-name",
      this.expanded ? "Collapse" : "Expand",
    );
    this.panel.classList.toggle("assistantPanel--expanded", this.expanded);
    this.render(this.controller!.snapshot);
  }

  private closeSidebar(): void {
    this.sidebarOpen = false;
    this.render(this.controller!.snapshot);
    this.sessionToggle.focus();
  }

  private submit(): void {
    // Router callbacks can race a Send click; take an authoritative host
    // snapshot synchronously at the action boundary.
    if (this.contextProvider)
      this.controller?.setHostContext(
        this.contextProvider.getContext() as PageContext | null,
      );
    if (this.controller?.sendMessage(this.draft)) {
      this.draft = "";
      this.input.value = "";
      this.updateComposer(this.controller.snapshot);
      this.input.focus();
    }
  }

  private updateComposer(state: AssistantState): void {
    this.input.disabled = state.generating || !!state.pendingConfirmation;
    this.send.toggleAttribute(
      "disabled",
      this.input.disabled || !state.connected || !this.draft.trim(),
    );
  }

  private render(state: AssistantState): void {
    this.launcher.hidden = state.isOpen || this.hasAttribute("hide-launcher");
    this.launcher.classList.toggle(
      "assistantLauncher--context",
      !!state.contextLabel,
    );
    this.launcher.classList.toggle(
      "assistantLauncher--unavailable",
      state.connection.phase === "unavailable",
    );
    this.panel.hidden = !state.isOpen;
    this.sidebar.hidden = !state.isOpen || !this.sidebarOpen;
    this.panel.classList.toggle(
      "assistantPanel--sidebar-open",
      this.sidebarOpen,
    );
    this.sessionToggle.setAttribute("aria-expanded", String(this.sidebarOpen));
    this.headerLabel.textContent = "TIDE";
    const connectionRow = this.connection.parentElement!;
    connectionRow.hidden = state.connection.phase === "ready";
    const labels = {
      connecting: "Connecting to the assistant...",
      reconnecting: `Reconnecting (${state.connection.attempt}/${state.connection.maxAttempts})...`,
      unavailable:
        state.connection.lastError === "authentication"
          ? "Your session has expired. Sign in again to continue."
          : "The assistant is unavailable. Your draft is safe.",
      ready: "",
    };
    this.connection.textContent = labels[state.connection.phase];
    this.connection.setAttribute(
      "design",
      state.connection.phase === "unavailable" ? "Negative" : "Information",
    );
    this.connectionAction.hidden = state.connection.phase !== "unavailable";
    this.connectionAction.textContent =
      state.connection.lastError === "authentication"
        ? "Sign in again"
        : "Retry";
    this.connectionAction.onclick = () =>
      state.connection.lastError === "authentication"
        ? this.controller?.signInAgain()
        : this.controller?.retryConnection();
    this.takeDraft(state);
    this.renderContext(state);
    this.updateComposer(state);
    this.renderSessions(state);
    this.renderMessages(state);
    this.renderConfirmation(state);
  }

  /** A seeded question ("Why?") goes into the input; nothing is sent. */
  private takeDraft(state: AssistantState): void {
    if (state.draft === null) return;
    const draft = this.controller!.takeDraft() ?? "";
    this.draft = draft;
    this.input.value = draft;
  }

  private renderContext(state: AssistantState): void {
    this.renderPromptSuggestions(state);
    this.contextChip.hidden = !state.contextLabel;
    if (!state.contextLabel) {
      delete this.contextChip.dataset.label;
      this.contextChip.replaceChildren();
      return;
    }
    if (this.contextChip.dataset.label !== state.contextLabel)
      delete this.contextChip.dataset.label;
    if (this.contextChip.dataset.label === state.contextLabel) return;
    this.contextChip.dataset.label = state.contextLabel;
    const remove = button("decline", "Remove context", () =>
      this.controller?.clearContext(),
    );
    remove.setAttribute("design", "Transparent");
    this.contextChip.replaceChildren(
      element("span", "assistantContextLabel", "Context:"),
      element("span", "assistantContextValue", state.contextLabel),
      remove,
    );
  }

  private renderPromptSuggestions(state: AssistantState): void {
    const appId = this.getAttribute("app-id") ?? "";
    const context = (state.pageContext ?? defaultPageContext(appId)) as
      (PageContext & { surface?: AssistantPageContextV1["surface"] }) | null;
    const prompts = promptsForContext(context as AssistantPageContextV1 | null);
    const signature = JSON.stringify(prompts.map(({ id }) => id));
    if (this.promptSuggestions.dataset.signature === signature) return;
    this.promptSuggestions.dataset.signature = signature;
    this.promptSuggestions.hidden = prompts.length === 0;
    this.promptSuggestions.setAttribute("role", "group");
    this.promptSuggestions.setAttribute(
      "aria-label",
      "Suggested questions for this page",
    );
    this.promptSuggestions.replaceChildren(
      ...prompts.map((prompt) => {
        const suggestion = element(
          "button",
          "assistantPromptSuggestion",
          prompt.label,
        );
        suggestion.type = "button";
        suggestion.addEventListener("click", () => {
          this.draft = prompt.prompt;
          this.input.value = prompt.prompt;
          this.updateComposer(this.controller!.snapshot);
          this.input.focus();
        });
        return suggestion;
      }),
    );
  }

  private renderSessions(state: AssistantState): void {
    const query = this.sidebarSearch.value.trim().toLocaleLowerCase();
    this.sidebarSearch.parentElement!.hidden = state.sessions.length < 8;
    const groups = new Map<string, typeof state.sessions>();
    for (const session of state.sessions.filter((item) =>
      item.title.toLocaleLowerCase().includes(query),
    )) {
      const age = Date.now() - session.updatedAt;
      const label =
        age < 86400000 ? "Today" : age < 604800000 ? "This week" : "Earlier";
      groups.set(label, [...(groups.get(label) ?? []), session]);
    }
    const groupNodes: HTMLElement[] = [];
    for (const label of ["Today", "This week", "Earlier"]) {
      const sessions = groups.get(label);
      if (!sessions?.length) continue;
      const chats = element("details", "assistantSessionGroup");
      chats.open = this.chatsGroupOpen;
      chats.addEventListener("toggle", () => {
        this.chatsGroupOpen = chats.open;
      });
      const rows = element("div", "assistantSessionRows");
      for (const session of sessions) {
        const row = element("div", "assistantSessionRow");
        const item = element(
          "button",
          `assistantSessionItem${session.id === state.activeSessionId ? " assistantSessionItem--active" : ""}`,
        );
        item.type = "button";
        item.append(
          element("span", "assistantSessionTitle", session.title),
          element(
            "span",
            "assistantSessionTime",
            this.relativeTime(session.updatedAt),
          ),
        );
        item.addEventListener("click", () => {
          this.controller?.selectSession(session.id);
          if (window.matchMedia("(max-width: 899px)").matches)
            this.closeSidebar();
        });
        row.append(item);
        if (session.id === state.activeSessionId) {
          const menu = element("details", "assistantSessionMenu");
          const trigger = element("summary");
          trigger.setAttribute("aria-label", `Actions for ${session.title}`);
          trigger.textContent = "...";
          const options = element("div", "assistantSessionMenuOptions");
          const rename = button("edit", "Rename conversation", () => {
            const title = window.prompt("Rename conversation", session.title);
            if (title?.trim())
              this.controller?.renameSession(session.id, title);
          });
          rename.textContent = "Rename";
          const remove = button(
            "delete",
            "Delete conversation from this browser",
            () => {
              if (
                window.confirm(
                  `Remove "${session.title}" from this browser? Server history is not deleted.`,
                )
              ) {
                this.controller?.removeSession(session.id);
              }
            },
            "assistantSessionDelete",
          );
          remove.textContent = "Delete from this browser";
          options.append(rename, remove);
          menu.append(trigger, options);
          menu.addEventListener("toggle", () => {
            if (!menu.open) return;
            const panelBounds = this.panel.getBoundingClientRect();
            const triggerBounds = trigger.getBoundingClientRect();
            const menuWidth = options.getBoundingClientRect().width;
            const menuHeight = options.getBoundingClientRect().height;
            options.style.top = `${Math.max(panelBounds.top + 8, Math.min(triggerBounds.bottom, panelBounds.bottom - menuHeight - 8))}px`;
            options.style.left = `${Math.max(panelBounds.left + 8, Math.min(triggerBounds.right - menuWidth, panelBounds.right - menuWidth - 8))}px`;
          });
          row.append(menu);
        }
        rows.append(row);
      }
      const title = element("summary", "assistantSessionGroupTitle");
      title.append(
        element("span", undefined, label),
        element("span", "assistantSessionCount", String(sessions.length)),
      );
      chats.append(title, rows);
      groupNodes.push(chats);
    }
    if (!groupNodes.length)
      groupNodes.push(
        element("p", "assistantHistoryEmpty", "No conversations yet."),
      );
    this.sidebarList.replaceChildren(...groupNodes);
  }

  private renderMessages(state: AssistantState): void {
    this.messages.classList.toggle(
      "assistantMessages--empty",
      state.messages.length === 0,
    );
    const atBottom =
      this.messages.scrollHeight -
        this.messages.scrollTop -
        this.messages.clientHeight <
      48;
    const currentIds = new Set(state.messages.map((message) => message.id));
    for (const [id, node] of this.messageNodes) {
      if (!currentIds.has(id)) {
        node.remove();
        this.messageNodes.delete(id);
      }
    }
    const activitiesByTurn = new Map<string, AssistantActivity[]>();
    for (const activity of state.activities) {
      const entries = activitiesByTurn.get(activity.turnId) ?? [];
      entries.push(activity);
      activitiesByTurn.set(activity.turnId, entries);
    }
    for (const [turnId, node] of this.traceNodes) {
      if (!activitiesByTurn.has(turnId)) {
        node.remove();
        this.traceNodes.delete(turnId);
      }
    }
    const ordered: { order: number; node: HTMLElement }[] = [];
    for (const message of state.messages) {
      let node = this.messageNodes.get(message.id);
      if (!node) {
        node = element(
          "div",
          message.role === "error"
            ? ""
            : `assistantMessage assistantMessage--${message.role === "note" ? "assistant assistantMessage--note" : message.role}`,
        );
        this.messageNodes.set(message.id, node);
      }
      const hasTrace = !!activitiesByTurn.get(message.turnId)?.length;
      if (
        node.dataset.text !== message.text ||
        node.dataset.hasTrace !== String(hasTrace)
      ) {
        node.dataset.text = message.text;
        node.dataset.hasTrace = String(hasTrace);
        if (message.role === "error") {
          const strip = element("ui5-message-strip", undefined, message.text);
          strip.setAttribute("design", "Negative");
          strip.setAttribute("hide-close-button", "");
          node.replaceChildren(strip);
        } else if (message.role === "note") {
          const body = element("div", "assistantMessageBody");
          body.append(renderMarkdown(message.text));
          node.replaceChildren(body);
        } else if (message.role === "assistant") {
          const copy = button(
            "copy",
            "Copy",
            () => void navigator.clipboard?.writeText(node!.dataset.text ?? ""),
          );
          const actions = element("div", "assistantMessageActions");
          actions.append(copy);
          const votes: {
            value: "positive" | "negative";
            icon: string;
            label: string;
          }[] = [
            {
              value: "positive",
              icon: "thumb-up",
              label: "Mark helpful locally",
            },
            {
              value: "negative",
              icon: "thumb-down",
              label: "Mark unhelpful locally",
            },
          ];
          for (const vote of votes) {
            const control = button(vote.icon, vote.label, () => {
              if (this.feedback.get(message.id) === vote.value)
                this.feedback.delete(message.id);
              else this.feedback.set(message.id, vote.value);
              for (const item of actions.querySelectorAll<HTMLElement>(
                "ui5-button[data-vote]",
              )) {
                item.setAttribute(
                  "aria-pressed",
                  String(this.feedback.get(message.id) === item.dataset.vote),
                );
              }
            });
            control.dataset.vote = vote.value;
            control.setAttribute(
              "aria-pressed",
              String(this.feedback.get(message.id) === vote.value),
            );
            actions.append(control);
          }
          const priorPrompt = state.messages.find(
            (entry) => entry.turnId === message.turnId && entry.role === "user",
          )?.text;
          if (priorPrompt)
            actions.append(
              button("refresh", "Reuse prompt", () => {
                this.draft = priorPrompt;
                this.input.value = priorPrompt;
                this.updateComposer(this.controller!.snapshot);
                this.input.focus();
              }),
            );
          if (hasTrace)
            actions.append(
              button("hint", "Show activity", () => {
                const trace = this.traceNodes.get(message.turnId);
                if (trace) {
                  trace.open = true;
                  trace.scrollIntoView({ block: "nearest" });
                }
              }),
            );
          actions
            .querySelectorAll("ui5-button")
            .forEach((control) =>
              control.setAttribute("design", "Transparent"),
            );
          const body = element("div", "assistantMessageBody");
          body.append(renderMarkdown(message.text));
          node.replaceChildren(body, actions);
        } else {
          const body = element("div", "assistantMessageBody", message.text);
          const actions = element("div", "assistantMessageActions");
          actions.append(
            button("edit", "Edit message", () => {
              this.draft = message.text;
              this.input.value = message.text;
              this.updateComposer(this.controller!.snapshot);
              this.input.focus();
            }),
          );
          actions
            .querySelector("ui5-button")!
            .setAttribute("design", "Transparent");
          node.replaceChildren(body, actions);
        }
      }
      ordered.push({ order: message.order, node });
    }
    for (const [turnId, activities] of activitiesByTurn) {
      let node = this.traceNodes.get(turnId);
      if (!node) {
        node = element("details", "assistantTrace");
        this.traceNodes.set(turnId, node);
      }
      const signature = JSON.stringify(activities);
      if (node.dataset.signature === signature) {
        ordered.push({ order: activities[0].order, node });
        continue;
      }
      const openTools = new Set(
        [
          ...node.querySelectorAll<HTMLDetailsElement>(
            ".assistantActivity[open]",
          ),
        ].map((item) => item.dataset.id),
      );
      const summary = element("summary", "assistantTraceHeader");
      summary.append(
        element("span", "assistantTraceMarker"),
        element("span", "assistantTraceTitle", "Activity"),
        element(
          "span",
          "assistantTraceCount",
          `${activities.length} ${activities.length === 1 ? "step" : "steps"}`,
        ),
      );
      const steps = element("div", "assistantTraceSteps");
      node.dataset.state = activities.some(
        (activity) => activity.state === "error",
      )
        ? "error"
        : activities.some((activity) => activity.state === "started")
          ? "started"
          : activities.some((activity) => activity.state === "declined")
            ? "declined"
            : "complete";
      for (const activity of activities) {
        const step = element("details", "assistantActivity");
        step.dataset.id = activity.id;
        step.dataset.state = activity.state;
        step.open = openTools.has(activity.id);
        const header = element("summary", "assistantActivityHeader");
        header.append(
          element("span", "assistantActivityMarker"),
          element("span", "assistantActivityLabel", activityHeader(activity)),
        );
        step.append(header);
        const detail = element(
          "pre",
          "assistantActivityDetail",
          JSON.stringify(
            { arguments: activity.argsSummary, result: activity.summary },
            null,
            2,
          ),
        );
        step.append(detail);
        steps.append(step);
      }
      node.replaceChildren(summary, steps);
      node.dataset.signature = signature;
      ordered.push({ order: activities[0].order, node });
    }
    this.renderCards(state, ordered);
    ordered.sort((first, second) => first.order - second.order);
    const divider = state.messages.length
      ? (this.messages.querySelector<HTMLElement>(".assistantDivider") ??
        element("div", "assistantDivider"))
      : null;
    if (divider)
      divider.textContent = new Date(state.messages[0].time).toLocaleDateString(
        undefined,
        { dateStyle: "long" },
      );
    const history = state.historyUnavailable
      ? (this.messages.querySelector<HTMLElement>(".assistantHistoryNotice") ??
        element("div", "assistantHistoryNotice"))
      : null;
    if (history)
      history.replaceChildren(
        document.createTextNode("Earlier messages unavailable. "),
        button("refresh", "Retry loading earlier messages", () =>
          this.controller?.retryConnection(),
        ),
      );
    const loading = state.historyLoading
      ? element("p", "assistantHistoryLoading", "Loading earlier messages...")
      : null;
    const empty =
      state.messages.length || history
        ? null
        : (this.messages.querySelector<HTMLElement>(".assistantEmptyPrompt") ??
          element(
            "p",
            "assistantEmptyPrompt",
            state.contextLabel
              ? `Ask about ${state.contextLabel}.`
              : "Ask about an order, risk, or next step.",
          ));
    const children = [
      ...(history ? [history] : []),
      ...(loading ? [loading] : []),
      ...(empty ? [empty] : []),
      ...(divider ? [divider] : []),
      ...ordered.map((entry) => entry.node),
    ];
    if (
      this.messages.childNodes.length !== children.length ||
      children.some((node, index) => node !== this.messages.childNodes[index])
    ) {
      this.messages.replaceChildren(...children);
    }
    const lastTurn = state.turnOrder.at(-1);
    const hasActivity =
      state.messages.some(
        (message) => message.turnId === lastTurn && message.role !== "user",
      ) || state.activities.some((activity) => activity.turnId === lastTurn);
    if (state.generating && !hasActivity) {
      const typing = element("div", "assistantTyping");
      typing.setAttribute("aria-label", "Assistant is responding");
      typing.append(element("span"), element("span"), element("span"));
      this.messages.append(typing);
    }
    if (atBottom) this.messages.scrollTop = this.messages.scrollHeight;
  }

  private relativeTime(time: number): string {
    const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (minutes < 1) return "Now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    return `${Math.floor(minutes / 1440)}d`;
  }

  private renderCards(
    state: AssistantState,
    ordered: { order: number; node: HTMLElement }[],
  ): void {
    const ids = new Set(state.cards.map((c) => c.id));
    for (const [id, node] of this.cardNodes)
      if (!ids.has(id)) {
        node.remove();
        this.cardNodes.delete(id);
      }
    for (const card of state.cards) {
      let node = this.cardNodes.get(card.id);
      if (!node) {
        node = renderCard(card);
        this.cardNodes.set(card.id, node);
      }
      ordered.push({ order: card.order, node });
    }
  }

  private renderConfirmation(state: AssistantState): void {
    const pending = state.pendingConfirmation;
    this.confirmation.hidden = !pending;
    if (!pending) {
      this.confirmation.replaceChildren();
      return;
    }
    const card = element("section", "assistantApproval");
    card.setAttribute("aria-label", "Approval required");
    const prediction = pending.calls.find(
      (call) =>
        call.name === "predict_orders" ||
        call.name === "start_lead_time_prediction",
    );
    const label = approvalActionLabel(pending.tool, prediction?.args?.target);
    const header = element("div", "assistantApprovalHeader");
    header.append(
      element("span", "assistantApprovalMarker"),
      element(
        "span",
        "assistantApprovalTitle",
        prediction ? label : `Approve ${label}?`,
      ),
    );
    const summary = element(
      "p",
      "assistantApprovalSummary",
      prediction
        ? "Estimate matching open purchase-order items and check the result against recent history."
        : (pending.proposal?.summary as string) || `Approve ${label}?`,
    );
    const scope = element("dl", "assistantApprovalScope");
    const key = prediction?.args?.key;
    if (key && typeof key === "object" && !Array.isArray(key)) {
      for (const [name, value] of Object.entries(key)) {
        if (value == null || value === "") continue;
        scope.append(
          element(
            "dt",
            undefined,
            name.replace(/^./, (character) => character.toUpperCase()),
          ),
          element("dd", undefined, String(value)),
        );
      }
    }
    const calls = element("div", "assistantApprovalCalls");
    const technical = element("details", "assistantApprovalTechnical");
    technical.append(element("summary", undefined, "Technical details"));
    if (prediction && typeof pending.proposal?.summary === "string") {
      technical.append(
        element("p", "assistantApprovalSummary", pending.proposal.summary),
      );
    }
    for (const call of pending.calls) {
      const row = element("details", "assistantApprovalCall");
      const rowHeader = element("summary", "assistantApprovalCallHeader");
      rowHeader.append(
        element("span", "assistantActivityMarker"),
        element(
          "span",
          "assistantActivityLabel",
          call.name.replaceAll("_", " "),
        ),
      );
      const args = element(
        "pre",
        "assistantActivityDetail",
        JSON.stringify(call.args ?? {}, null, 2),
      );
      row.append(rowHeader, args);
      calls.append(row);
    }
    technical.append(calls);
    const actions = element("div", "assistantConfirmationActions");
    const cancel = button("", "Cancel", () => this.controller?.cancel());
    const confirm = button("", "Confirm", () => this.controller?.confirm());
    cancel.textContent = "Decline";
    confirm.textContent = prediction ? "Run prediction" : "Approve";
    confirm.setAttribute("design", "Emphasized");
    cancel.toggleAttribute("disabled", pending.submitting);
    confirm.toggleAttribute("disabled", pending.submitting);
    actions.append(cancel, confirm);
    card.append(header, summary, scope, technical, actions);
    this.confirmation.replaceChildren(card);
  }
}

customElements.define("tide-assistant", TideAssistant);
