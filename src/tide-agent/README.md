# agent

tide chat agent: a LangGraph + MCP tool loop served over AG-UI/SSE. CAP is the
only source of truth: the agent calls CAP's MCP endpoint with the user's own
credentials and holds conversation state, not authoritative business records.

## Security model

- **Every request is authenticated against CAP.** The agent forwards the
  caller's `Authorization` header to CAP's MCP endpoint (`initialize`) before
  doing anything: CAP answers 401 for bad credentials, 403 for users without
  the agent service's role. Only HTTP 200 with a matching, validated JSON-RPC
  initialization result and protocol version is accepted, over JSON or SSE.
  Redirects, empty bodies and MCP errors never authenticate. Accepted headers are cached for
  `AUTH_CACHE_SECONDS`. Only `/healthz` is open.
- **Threads belong to the user and app that started them.** Other users get
  404 on `/agent` and `/threads/{id}`, the same as for a thread that doesn't
  exist. Owners are stored next to the checkpoints (`CHECKPOINT_DB`).
- **Write tools need approval.** Tool calls CAP doesn't mark read-only pause
  the turn for the user's decision before anything runs.
  Resumed approval refreshes the caller-scoped catalog/profile and cannot expand
  the original turn's tool set. CAP still enforces business approval/readiness.
- **Plans execute in order.** Every model tool-call batch is validated against
  the CAP profile and its JSON Schema before consent or dispatch. Invalid
  schemas and non-local references fail closed; schema validation never fetches
  external resources. Consent resume checks the refreshed schema again.
  One dependency-ready call runs at a time. A failed
  step stops the remaining plan and sends the model back to replan from the
  verified result.
- **Safe reads recover.** Structured MCP failures retain a stable code,
  retryability and correlation reference. The executor retries transient reads,
  polls pending prediction runs, and can reconcile a declared conflict through
  its read-only reconciliation tool.
  Recovery and polling may invoke only currently catalogued, app-permitted read
  tools; server error metadata cannot authorize another write or widen scope.
- **Uncertain workflow writes are not retried.** `prepare_case_action` and
  `submit_review` reconcile through the runtime-only REST `command_result`
  operation with the retained command ID and exact attempted arguments.
  CAP reauthorizes the subjects and compares its
  persisted argument hash. Only `payloadMatched=true` for that command/type,
  Case and Action establishes completion; unavailable, mismatched or older
  receipts leave the outcome unknown. The original approved arguments remain
  unchanged, including source/version or Review token guards.
- **Write intent survives process death.** A separate connection commits a
  thread/user/app-scoped journal entry in `CHECKPOINT_DB` before dispatch.
  Its exact arguments and bounded result contain no credentials or page context.
  Cancellation or process exit cannot turn a possibly committed write into
  "not run". Reload repairs missing results; the next turn reconciles using only
  currently permitted reads. Pending or unknown attempts disable further writes
  until verified; confirmed failures do not permanently disable writes.
  Legacy checkpoint proposals without results are conservatively journaled as
  potentially dispatched, not replayed. A matching CAP receipt is required.
- **Runtime support is unavailable to the model.** Profiles, page-context
  resolution and command receipts use the authenticated REST runtime service,
  not MCP tools. The cockpit catalog exposes typed case preparation and Review
  submission, not compatibility row writes or recomputation operations.
- **No internal errors reach the client.** Failures are logged with the
  request's correlation ID; the client gets a generic message plus that ID.
- **Credentials never enter checkpoints.** The header lives in a
  request-scoped context variable only.

## Turn guarantees

Every turn, whatever the model does:

- **Fresh limits.** Step and tool-call budgets (`MAX_STEPS`, `MAX_TOOL_CALLS`)
  and the tool catalog are reset at the start of each turn; callers can only
  send messages, not state.
- **An answer at the end.** When the budget runs out, the agent makes one last
  LLM call without tools, or ends with a fixed message if no step is left.
- **A well-formed history.** Every stored tool call has exactly one result:
  calls over the budget, declined, unavailable or left dangling are answered
  with an error result adjacent to their call. Tool calls are capped before
  anything runs and execute sequentially; there is no parallel-tool setting.
- **Bounded size.** Tool results over `MAX_TOOL_RESULT_CHARS` are truncated
  with a note. The thread is trimmed to `MAX_HISTORY_TOKENS` by dropping
  whole exchanges from the front, so a tool call never loses its result.
- **The complete prompt is bounded.** Instructions, verification notes, page
  context, history and tool schemas count together. Accounting conservatively
  charges serialized UTF-8 bytes plus message overhead as tokens, rather than
  relying on a provider tokenizer. Old exchanges are removed first; oversized
  tool bodies are compacted with identifiers/status retained. If the newest
  request still cannot fit, the model is not called. Every call reserves output
  capacity and requests a bounded completion.
- **Incoming bodies are bounded before parsing.** POST bodies, including
  chunked bodies, are limited by actual bytes (413). Message count and serialized
  message size are checked separately (422).
- **Truthful outcomes.** Small structured run/action identifiers, status and
  failure metadata survive prompt truncation. Pending, failed and unknown work
  stops dependent plans. Authoritative warnings reach `tide.turn` and thread
  history even if the model claims completion; stream completion is not success.
- **The system prompt is never stored.** It is added to each LLM call only.
- **Page context is per-turn and ephemeral.** Optional structured `pageContext` is validated at the API boundary, resolved by CAP for the caller, and injected into LLM calls only; it is not stored in thread messages/checkpoints and cannot grant tool access.
- **Approvals block new input.** While a write call waits for a decision,
  `POST /agent` accepts only the decision (`resume`); new messages get 409.

## Develop

```sh
# From the repository root, with a provisioned populated CAP database:
npm run setup
npm start
```

The service refuses to start without an LLM configuration unless `LLM_FAKE=1`
is set. It needs CAP running (`CAP_URL`) to accept any request.

`scripts/run` delegates to root `npm start`, including gateway provisioning.
Both require live inference configuration; fake models remain available for
standalone agent development and tests.

`LLM_FAKE=1` swaps only the model: a deterministic offline model that calls
`list_priorities` when the app offers it (cockpit) and answers with the tool
result verbatim, otherwise a fixed text. Tools still come from CAP.

The supported app (`X-Tide-App-Id`) is `cockpit`. Its authorized catalog comes
from `/mcp/cockpit`, and instructions come from MCP initialization on every
turn. Runtime checks and page context come from `/rest/assistant-runtime`.

### Limits and storage

| Environment Variable   | Default | Meaning                                              |
| ---------------------- | ------- | ---------------------------------------------------- |
| `MAX_REQUEST_BYTES`    | 1048576 | Total POST body before JSON parsing.                 |
| `MAX_INPUT_MESSAGES`   | 200     | Incoming messages per request.                       |
| `MAX_MESSAGE_CHARS`    | 16000   | Serialized size of each incoming message.            |
| `MODEL_CONTEXT_TOKENS` | 128000  | Must match the gateway model's actual context limit. |
| `MAX_OUTPUT_TOKENS`    | 4096    | Reserved and requested completion limit.             |
| `PROMPT_SAFETY_TOKENS` | 2048    | Additional context margin.                           |

The usable prompt budget is context minus output reserve and safety margin.
Startup rejects non-positive budgets. `MAX_HISTORY_TOKENS` remains an initial
history-trimming limit, not a guarantee that the complete prompt fits.

Run one worker/process against local SQLite. Thread exclusion and capacity
limits are process-local, not distributed leases; this is not an HA design.
Idle thread locks are removed after use. Journal records are retained without
automatic expiry, especially unresolved writes: expiring them could permit an
unsafe replay. Operators must restrict file access, monitor disk use, back up
the checkpoint database, and manage conversation/journal retention together
while the service is stopped. Tool arguments may contain business information;
do not treat credential exclusion as anonymization.

## Gateway Transport

The root launcher supervises CAP, Tabular, the agent, and the local LiteLLM
Proxy. Configure `GATEWAY_UPSTREAM_MODEL`, `GATEWAY_UPSTREAM_API_KEY` and the
provider's base/version settings in the root `.env`. Existing direct-provider
`AGENT_MODEL*` settings remain a launcher-only migration input; they are not
passed to the real agent. Real standalone agent startup requires
`openai/agent-reasoning`, a gateway `/v1` base and its caller key.

The gateway has its own frozen uv environment under `gateway/`: the pinned
proxy requires MCP 1.x while the agent requires MCP 2.x. `npm run setup`
installs both without downgrading either. `GATEWAY_PORT` defaults to 4000.
Configured ports must be distinct and `MCP_URL`/`AGENT_URL` must match their
supervised local services. Startup rejects inherited fake mode.

`GATEWAY_AGENT_KEY` and `GATEWAY_CAP_KEY` must differ; blank values generate
per-launch local keys. Only the agent key may invoke `agent-reasoning` chat
completions. The CAP key is reserved and has no registered alias. The custom
authentication hook explicitly rejects other operations and aliases. No
gateway database, admin API, billing, or database-backed budget policy is
provisioned. LiteLLM's warning about DB common checks is intentional here;
local caller/alias checks are enforced by the hook, not DB team records.

Use `gateway/.venv/bin/python` when editing the gateway. A workspace interpreter
without the proxy extra can report an unresolved `litellm.proxy` import even
though the separately locked gateway imports and starts successfully.

Completion forwards `TURN_TIMEOUT_S`; adapter retries and direct/fake fallbacks
are disabled. Streamed tools and usage-only terminal chunks are retained. The
model key is excluded from model representation and serialization. Approved
gateway-side routing remains gateway-owned; proxy errors propagate to the API's
safe error path. Offline mocked transport checks are not live conformance.

The client consumes the pinned AG-UI `RUN_FINISHED` interrupt outcome and
normalizes legacy JSON-text interrupts and authenticated history through the
same decoder. A pending proposal blocks ordinary input and retains exact call
IDs and arguments across reload. Only a verified tool result completes an
activity; EOF or stream completion alone leaves its outcome unverified.

Canonical preparation command IDs are generated by the runtime before consent,
not by the model. They remain in the checkpointed executable proposal across
resume, with the unchanged CAP evidence guards. Cockpit profiles declaring
business actions without the Workflow command contract fail closed.

Business-write replay still requires CAP's stable command/receipt contract.
The agent does not synthesize receipts, turn write permission into business
approval, or retry an ambiguous committed write under a fresh command ID.

## Local Live Acceptance (2026-10-04)

The shipped cockpit at `http://localhost:4504/tide.cockpit/index.html` used
`agent-url="/agent"`, the real `agent-reasoning` gateway route, and a populated
CAP backup at `/tmp/tide-agent-acceptance.sqlite`. Conversation checkpoints used
`/tmp/tide-agent-acceptance-checkpoints.sqlite`; the shared database was not
mutated. Local mocked CAP credentials were supplied through the assistant's
public `authToken` property for browser automation.

| Check                  | Observed Result                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real purchasing read   | Rendered 4500000069/50, 4500000081/10, and 4500000388/10 with CAP's revenue risks.                                                               |
| Consent and decline    | Exact IDs/guards restored while pending; input blocked; decline left no Action or command receipt.                                               |
| Consented preparation  | One reminder Action in `needs_decision`, one receipt, and one event each for Case and Action; Case remained open.                                |
| Replay and guards      | Exact replay returned the same Action; changed arguments, stale evidence and an out-of-scope caller were rejected.                               |
| Lost-response recovery | The existing reconciliation helper recovered the matching committed receipt; a missing receipt did not establish success.                        |
| Gateway boundaries     | Missing/wrong keys returned 401; wrong alias and reserved CAP caller returned 403; an unavailable-gateway adapter check failed without fallback. |
| Persistence and layout | Both conversations and the same Action survived process restart; mobile consent width and long-token wrapping were checked.                      |

The accepted command was `e3f6a64c-5b91-4ac9-82da-019dba469fe6`, for
`delivery:4500000081/10`, with Action `0399eff2-d89d-4524-8cdb-bcd933c2eb7c`.
The declined proposal used a different command ID and produced no receipt.
Two chat conversations were used; no supplier communication, business approval,
SAP posting, or new numerical prediction was executed.

Verification used compile, assistant typecheck/build, supervised startup and
focused live checks only: no new tests, suites or lint passes. This evidence
does not certify supplier preparation, Review submission, full lifecycle/source
cutover, or production deployment. Those workflow owners retain their existing
readiness gates.

## Endpoints

| Endpoint            | Auth       | Purpose                                      |
| ------------------- | ---------- | -------------------------------------------- |
| `POST /agent`       | yes        | One AG-UI turn (SSE). Needs `X-Tide-App-Id`. |
| `GET /threads/{id}` | yes, owner | Rebuild a chat after reload.                 |
| `GET /readyz`       | yes        | CAP is reachable and accepts this caller.    |
| `GET /healthz`      | no         | Liveness only.                               |

Logs are JSON on stdout, one line per event, each with `correlation_id`. The
ID is taken from `X-Correlation-Id` or generated, returned on the response,
and forwarded to CAP on every MCP call.

## Test

```sh
uv run --frozen python -m pytest
uv run --frozen pyright
uv run --frozen ruff check . && uv run --frozen ruff format --check .
```

From the repository root, `scripts/check agent assistant` runs the credential-free
component gates. From `src/tide-cap`, the real MCP integration uses a scripted model
and an isolated test database:

```sh
CAP_AGENT_E2E=1 CDS_ENV=test CDS_TYPESCRIPT=true node --import tsx --test --test-force-exit --test-concurrency=1 test/workflow-commands.test.ts
```

Pyright checks all agent source in strict mode. Missing third-party stub and
deprecation notices are excluded from this gate; LangGraph builder and pinned
AG-UI extension signatures use explicit SDK-boundary casts. Business state,
plans, ports and execution outcomes remain typed. `app/execution.py` owns tool
execution/recovery; graph nodes own scheduling and consent. MCP 2 transport
uses `httpx2`, while the identity probe uses `httpx` with the SDK's SSE parser.
The exact AG-UI pin remains required because the adapter extends its internals.

Temporary-database regressions cover cancellation, hard process exit immediately
after simulated commit, reopened journals, legacy proposals, exact receipt
matching, unknown outcomes, owner/app scoping and credential exclusion. Offline
tests do not replace live CAP/gateway conformance; the dated acceptance report
above describes an earlier run, not automatic verification of subsequent changes.

For the shipped host, build the assistant, install the pinned Playwright browser
once, then run against an existing local CAP server:

```sh
npm run build:assistant:purchasing-desk
npx playwright install chromium
node test/browser/assistant-recovery.mjs http://localhost:4404
```

That browser check intercepts all test-model traffic, asserts zero live Agent
calls, exercises desktop/mobile lifecycle and pending/unknown reconnect, and
writes screenshots to `/tmp/tide-assistant-recovery`. It reads the cockpit but
does not issue business writes. UI5 assets may require network access. Process-exit
regressions in `tests/test_checkpoint.py` reopen temporary SQLite stores and prove
the warnings persist without storing caller credentials. These checks are local
integration evidence, not live gateway conformance or a whole-CAP build certificate.

## MCP Turn Scope

Each streamed HTTP turn owns one caller-bound MCP session, opened inside the
turn timeout and concurrency limit. Catalog, native instructions and MCP tool
execution share that session. Profiles, page context and command receipts use
separate authenticated REST requests. Approval resume is a new HTTP turn:
it opens a new session and still refetches the catalog and profile. Nothing is
cached globally, and another caller or nested scope on the same client is
rejected. Credentials and sessions are never checkpointed. Completion,
interruption, failure and cancellation close the scope and clear its state.
Standalone adapter calls outside a turn keep their original per-call sessions.
Transport failures do not automatically replay writes.

### Model Surface (2026-10-04)

The cockpit-only CDS model compiles with 14 MCP tools (11 reads and 3 actions).
Its native instructions occupy 2,967 UTF-8 bytes, down from 6,850 bytes in the
earlier shared-service assessment. This pass removed 291 bytes of duplicated
greeting/capability guidance; the agent's system prompt retains that guidance.
These are source-contract measurements, not measured provider token counts or
confirmation that an already-running server has loaded the latest source.

Page context is advisory and cannot change tool authority. No dynamic page
subsets were added: the reduced catalog remains available for cross-page buyer
questions. Version/fingerprint guards, Review tokens, runtime-generated command
IDs, consent and exact receipt matching remain unchanged.

### Local Check Results (2026-10-04)

The agent gate passed lint, formatting, strict Pyright and 196 tests; the
opt-in CAP write integration remained skipped in the offline gate. Desktop
and mobile browser lifecycle/reconnect checks passed with zero live agent calls.
Live Azure/CAP checks against an isolated database passed tool execution,
stream completion, history reload, persisted consent, decline without dispatch,
pending-input rejection and app ownership. Same-thread concurrency returned
409 as expected. Real MCP cancellation and a forced HTTP timeout released
resources; a subsequent turn on the same thread completed.

The read-only MCP benchmark ran catalog, instructions, context resolution and
priorities three times before and after optimization. Initializations fell
from four to one per batch. Elapsed times were 119.0/118.1/92.6 ms before and
60.5/72.5/35.7 ms after (median 118.1 to 60.5 ms). These are small local samples,
not a total-model-latency or production-throughput guarantee. A temporary
optimized agent also completed a real Azure/CAP SSE turn and persisted history.
The original running stack was left untouched; restart the agent to apply
the updated scope there.

The broader local setup was not all green at the time of the checks:

- Assistant typecheck passed, but 2 of 40 controller tests failed: snapshot
  activity completion and the legacy Add-to-worklist preparation path.
- Of five focused CAP workflow/MCP acceptance tests, HTTP approval/version
  checks and direct receipt/identity reconciliation passed; three supplier
  preparation/profile/graph-transport tests failed against the freshly compiled
  model. The older running server still exposed those tools, so its live result
  cannot certify the newer source contracts.
- Root doctor first reported an unloaded default database. With the isolated
  loaded database selected, it was blocked by duplicate `[project]` sections in
  the loader project configuration. These independent files were not changed
  as part of the MCP optimization.
- Storage inspection sampled two journal entries with no unresolved entries;
  automatic retention remains deliberately disabled and disk monitoring is
  still an operator responsibility.
