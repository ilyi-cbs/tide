# Buyer Cockpit (Fiori Elements V4)

Open PO items at risk, ranked by revenue at risk, with realistic lead-time
ranges (TabPFN or own history), sources with implausible planned delivery
times, approvals and proof. Nothing is sent to suppliers or written to SAP.

## How to run

The root launcher loads verified source data and starts the gateway, tabular
service, CAP and agent in the foreground. CAP automatically prepares a loaded
dataset once per `(asOf, loadId)` and reuses its published snapshot on later
starts. Configure live provider credentials in the root `.env`, then run from
the repository root:

```sh
npm run setup
npm run data:load
npm run doctor
npm start              # scripts/run is a compatibility wrapper
```

Ctrl+C stops the supervised services. Existing databases are never reset or
automatically migrated; use an explicit fresh `TIDE_DB` path for a new schema.
The old reset, stop, status and force-port commands are retired. Occupied ports
are rejected without stopping their owners. See the root [README](../../../../README.md)
for configuration and the committed demo's source-quality limitations.

Open `http://localhost:<CAP_PORT>/tide.cockpit/index.html` (user `ilyesse.hettenbach@cbs-consulting.de` / `alice`).
With a non-default agent port, add `?agentUrl=http://localhost:<AGENT_PORT>`.

Environment (defaults in brackets):

| Variable                                                                             | Meaning                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `CAP_PORT` [4004], `TABULAR_PORT` [8080], `AGENT_PORT` [8081], `GATEWAY_PORT` [4000] | distinct local service ports                                        |
| `TIDE_DB` [`src/tide-cap/.data/cockpit.sqlite`]                                      | SQLite database, resolved relative to the repository root           |
| `TIDE_DATASET` [`data/demo`]                                                         | manifest-attested source directory                                  |
| `TIDE_SOURCE_SYSTEM` [local-demo]                                                    | source identity recorded during intake                              |
| `CHECKPOINT_DB` [`.data/checkpoints.sqlite`]                                         | agent checkpoint database                                           |
| `TABULAR_BACKEND`                                                                    | `aicore` or `priorlabs`; credentials required                       |
| `LLM_FAKE`                                                                           | fake inference is rejected by the root launcher; reserved for tests |
| `TIDE_PREPARE_TIMEOUT_MS` [3600000]                                                  | milliseconds to wait for a published preparation snapshot           |

Real TabPFN on SAP AI Core and a real chat LLM (credentials in `.env`, see
`.env.example`):

```sh
TABULAR_BACKEND=aicore LLM_FAKE=0 scripts/run
```

## Pages

| Route                                  | Page                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `#`                                    | Overview (custom FPM page): KPI tiles, scope filter, top priorities                                                     |
| `#Worklist`                            | List report, tabs Needs Action / All Open / Customers / Lead Times to Fix; Prepare Reminder                             |
| `#/OpenItems(...)`                     | PO item: status, delay, € at risk, range bar, customer orders, source, model; Recompute, Why? (chat), Prepare Reminder  |
| `#/SourceFindings(...)`                | Source (info record): SAP vs. reality, proposal, what-if, backtest, open items; Add to Change List                      |
| `#/Customers(...)`                     | Customer: revenue at risk, waiting customer order items                                                                 |
| `#Approvals`                           | Tabs Prepared Actions (approve / reject, CSV) and Prediction Questions (chat "predict on request")                      |
| `#/Actions(<ID>)`, `#/Questions(<ID>)` | Prepared action; prediction question with backtest gate and ranking                                                     |
| `#Proof`                               | Proof (custom FPM page): SAP plan vs. medians vs. TabPFN, chart and table                                               |
| `#Prevention`                          | Type-specific tabs for price, duplicate, rare-setting, supplier planned-time, and material-master planned-time findings |

The chat panel (app id `cockpit`) is on every page; its links (`#/...`) open these pages.

Files: `annotations.cds` (all UI annotations), `webapp/manifest.json`
(routes, tabs, custom actions/sections), `webapp/ext/` (overview, proof,
range bar, what-if, actions), `webapp/i18n/`.

## AI-assisted requisition workspace

`#/PurchaseRequisitionReviews(...)` opens a compact order-preparation workspace.
The original PR remains immutable; the editable working copy uses CAP drafts.
Source values are prefilled, purchasing-group suggestions are provisional, and
ranked alternatives appear next to their fields. Material-group and supplier
suggestions require an explicit **Use suggestion** or value-help selection.
Changing plant/organisation suppresses evidence calculated for the old context.

Save the draft, choose **Review order draft**, then **Submit draft for approval**.
The final gesture records acceptance of unchanged current suggestions together.
The summary is protected by both the working-copy timestamp and a payload hash,
including allocations. Approval locks the reviewed values and enables:

- **Download approved draft**: versioned JSON containing the frozen preparation
  payload, account assignments, provenance and approval details.
- **Download review CSV**: the existing field-change handoff for external processing.

Both downloads are preparation artifacts. No PO is created or written to SAP.
Pricing is explicitly requisition valuation, not agreed order pricing. External
posting is recorded in Approvals; source refresh confirms completion. Direct S/4
creation requires an API/destination adapter and a durable execution workflow.

### Draft-safe AI assistance

The five supported working fields expose a compact assistance icon beside the
standard Fiori field. The responsive evidence popover shows ranked candidates,
raw model score, separately measured reliability, supporting history, freshness,
and calculation metadata. Predict creates draft-owned evidence only; Apply and
Confirm are separate buyer actions. Account-assignment and item-category
suggestions remain review-only and are disabled when no qualifying calibration
exists. Pending work is polled for up to 120 seconds and cannot recreate a draft
that was saved or discarded while inference was running.

### Existing databases

Apply the additive CDS schema changes using the project's normal deployment
workflow before running the updated service. New `workingCopyVersion` and
`fieldOrigins` columns preserve buyer edits and explicit clears. Untouched legacy
rows are repaired on read/source sync; ambiguous legacy blanks are preserved.

### Verification

Offline backend regression tests:

```sh
CDS_ENV=test CDS_TYPESCRIPT=true node --import tsx --test --test-force-exit --test-concurrency=1 test/freetext-review.test.ts test/freetext-logic.test.ts
```

Optional real-browser journey (run from the CAP root with Playwright and Chromium
installed; `PLAYWRIGHT_MODULE` can point to an external installed package):

```sh
CDS_UI_BROWSER=true CDS_ENV=test CDS_TYPESCRIPT=true node --import tsx --test --test-force-exit test/requisition-browser-fixture.test.ts
```

The browser test uses an in-memory fixture and drives alternatives, draft saving,
summary, approval, and both downloads. It needs network access to the configured
UI5 CDN. Ordinary backend tests skip it and remain offline.
