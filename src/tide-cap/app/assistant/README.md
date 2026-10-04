# @tide/assistant

Framework-independent chat assistant custom element built with UI5 Web Components.

## Build and check

From the CAP project directory, run `npm run build -w @tide/assistant`, `npm run test -w @tide/assistant`, and `npm run typecheck -w @tide/assistant`. The build writes browser-ready `dist/index.js` and `dist/index.css`; serve both files from your SAPUI5 application's static assets. The generated bundle includes the UI5 Web Components it uses. Rebuild after changes to the assistant source.

## Embed in a UI5 application

Load the CSS and module from your host's asset paths, then place the element anywhere in the document body:

```html
<link rel="stylesheet" href="/assistant/index.css">
<script type="module" src="/assistant/index.js"></script>
<tide-assistant app-id="product-catalog"></tide-assistant>
```

Use a stable, distinct `app-id` for each app. Set `element.userId` from authenticated host identity before opening; persistent session indexes are isolated by app and user. Without identity, sessions are memory-only. Changing identity recreates the client and clears its token, draft and rendered conversation; set the new identity before supplying its token. Old app-only indexes are cleared, not migrated to whichever user happens to sign in. This is browser-local isolation, not a replacement for server thread authorization or protection against scripts running on the same origin. Tokens are never stored in local storage.

The element starts with a floating launcher; its `openAssistant({ title: "Product catalog" })` and `closeAssistant()` methods let a host open and close it programmatically. `openAssistant(pageContext, { message: "Why is this item late?" })` seeds a draft; only `{ message: "Why?", send: true }` sends automatically when connected and idle. Closing before connection drops that queued message. Markdown links to in-app hash routes (`[item](#/OpenItems(...))`) open in the same tab; other links need http(s) and open in a new tab. Listen for the bubbling `tide:assistant-data-changed` event to refresh host data after a successful tool result; its `detail` is the tool-result payload.

Hosts can set `element.contextProvider = { getContext, subscribe }`. `getContext()` returns the current `AssistantPageContextV1` snapshot; `subscribe(listener)` notifies ChatUI when route/selection changes. ChatUI refreshes the chip and suggested prompt templates immediately, and reads `getContext()` again when Send is pressed. Explicit row actions may continue using `openAssistant(context, options)` and are treated as one-turn overrides. Context travels as a bounded structured `pageContext` request field, not as message text. CAP validates/canonicalizes supported cockpit context under the current caller; it remains advisory and is not authorization. Hosts should only pass small identifiers and stable surface IDs. The legacy `pageContextProvider` remains as a compatibility path. For the lead-time app, run `npm run build:assistant` from `cap/` after changes to the shared assistant.

The browser client connects to `/agent` on the origin given by the `agent-url` attribute (default: the current origin). The host must make the agent HTTP endpoint available there. Before opening the assistant in production, set `document.querySelector("tide-assistant").authToken` to the user's current bearer token. Set it again when the token changes; reconnects read the latest value. Do not put the token in an HTML attribute. The `tests/preview.html` fixture is a standalone browser preview and is not a production host integration.
