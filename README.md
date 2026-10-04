<!-- markdownlint-configure-file {"MD033": {"allowed_elements": ["p", "img", "h1", "strong", "br", "a"]}, "MD041": false} -->

<p align="center">
    <img src="./src/tide-cap/app/purchasing-desk/webapp/images/cbs-logo.png" alt="cbs" width="164">
    &nbsp;&nbsp;&nbsp;
    <img src="./src/tide-cap/app/purchasing-desk/webapp/images/tide-logo.png" alt="TIDE application logo" width="68">
</p>

<h1 align="center">cbs TIDE</h1>

<p align="center">
    <strong>Timing, Impact and Delivery Estimates</strong><br>
    Procurement decision support for manufacturing teams running SAP.
</p>

<p align="center">
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.15-417e38?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js 22.15 or newer"></a>
    <a href="https://docs.astral.sh/uv/"><img src="https://img.shields.io/badge/Python-%E2%89%A53.12-3776ab?style=flat-square&amp;logo=python&amp;logoColor=white" alt="Application Python: 3.12 or newer"></a>
</p>

<p align="center">
    <a href="#get-started">Get Started</a> &middot;
    <a href="#usage">Commands</a> &middot;
    <a href="#research">Research</a> &middot;
    <a href="https://www.youtube.com/watch?v=2w5yhF3qGBo">Video</a>
</p>

<p align="center">
    <img src="./src/tide-cap/app/purchasing-desk/webapp/images/tide-crab.png" alt="TIDE crab mascot" width="250">
</p>

---

## What is cbs TIDE?

cbs TIDE (Timing, Impact and Delivery Estimates) supports procurement teams in
manufacturing companies running SAP. The ERP system records scheduled and
confirmed dates for open purchase orders, but those dates aren't data-driven
estimates of actual arrival. When a part is late, finding the affected production
and customer orders takes several screens. Planned delivery times are often
outdated defaults, and free-text purchase requests are classified by hand.

TIDE brings these tasks into a Fiori app (SAP's web UI framework), with views for
orders at risk, lead times, order planning, free-text requests, and approvals,
plus a chat assistant.

TabPFN-3.5 is the single prediction engine. It uses order history as context,
without training a separate model for each task. The design also covers
materials and suppliers with only a few historical records; that does not
guarantee an accurate estimate for every sparse case.

The intended workflow has five parts:

1. **Arrival.** Quantile regression gives each open purchase order an arrival range, rather than a single promised date.
2. **Impact.** Arrival ranges are passed from purchased parts through production and customer orders. Late orders are ranked by revenue at risk, with valuation assumptions shown.
3. **Planning.** Lead-time estimates per material and supplier inform corrections to planned delivery times and give the latest order date.
4. **Free text.** Fields such as account assignment and material group are pre-filled when the class probability meets the acceptance threshold.
5. **Chat.** Questions outside the built-in views become new prediction targets. Prediction answers are returned only if TabPFN beats a simple baseline in a backtest. The language model interprets the question and phrases the result; it doesn't supply the numerical prediction.

Proposals require user approval, and nothing is written back to SAP. An estimated
arrival date is not a supplier commitment. Buyers can inspect the source records,
uncertainty, and assessment freshness before acting.

## Get Started

| Project                                        | Role                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| [src/tide-cap](src/tide-cap/readme.md)         | SAP CAP service, Fiori cockpit, and chat assistant UI.          |
| [src/tide-tabular](src/tide-tabular/README.md) | TabPFN inference service (Prior Labs API or SAP AI Core).       |
| [src/tide-agent](src/tide-agent/README.md)     | Chat agent (LangGraph) and its LLM gateway.                     |
| [src/tide-loader](src/tide-loader/README.md)   | Source-only intake of SAP-shaped Parquet into the CAP database. |

You need **Node.js 22.15 or newer**, npm, and
[uv](https://docs.astral.sh/uv/getting-started/installation/).
No live SAP system is needed for local use: the repository includes synthetic
data and SAP-shaped data interfaces. For inference, the simplest configuration
is a Prior Labs API key and an LLM supported by LiteLLM, with the credentials and
endpoint that provider requires.

Run the following from the repository root:

```sh
npm ci
npm run setup
```

Setup installs locked CAP and Python dependencies, builds the assistant bundle,
and creates the root `.env` from [.env.example](.env.example) if it doesn't
already exist. It leaves existing configuration alone. No services start and no
data is loaded. `uv` manages each app project's pinned Python version (currently
3.12); you don't need to activate a virtual environment or install a global npm
package. Research dependencies are separate.

### Configure

Edit the root `.env` before starting the app. Keep credentials out of Git.
Exported environment variables take precedence over this file.

| Setting                                              | What to provide                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GATEWAY_UPSTREAM_MODEL`, `GATEWAY_UPSTREAM_API_KEY` | Your LiteLLM model route and key. Azure routes also need `GATEWAY_UPSTREAM_API_BASE` (and `_API_VERSION`). |
| `TABULAR_BACKEND`                                    | `priorlabs` with `PRIORLABS_API_KEY`, or `aicore` with its `AICORE_*` credentials and deployment.          |
| `TIDE_DB`                                            | Database path (default `.data/retained/cap.sqlite`); a missing database is deployed from the CAP model.    |
| `TIDE_DATASET`                                       | Source directory with a manifest (default `data/demo`). Relative paths resolve from the repository root.   |

[.env.example](.env.example) documents the remaining settings and their defaults.

`npm run data:load` verifies and atomically imports source Parquet into the
target source tables. It does not call prediction providers or restore truth,
prepared read models, or synthetic history. Startup performs the same intake
automatically and preserves workflow state and history. The supplied `data/demo`
is synthetic demo input. Its export omits some requisition and accounting
fields, so the loader reports free-text pre-fill as unavailable for this dataset.
See the [intake contract](src/tide-loader/README.md) for details.

### Run

```sh
npm run data:load
npm run doctor
npm start
```

Doctor checks local prerequisites, provider configuration, source manifest
presence, and a read-only loaded-dataset marker. It doesn't call providers or
prove that every source record was ingested. Missing configuration or data
causes a nonzero exit.

Once the runner reports readiness, open
[the cockpit](http://127.0.0.1:4004/tide.cockpit/index.html) and sign in
with the local demo user `priorlabs` / `priorlabs`.
CAP, tabular, the agent, and its LLM gateway run in the foreground.
**Ctrl+C stops all of them.** If one service exits unexpectedly, the runner
stops the others. It refuses occupied ports; `npm start -- --force` first stops
the processes listening on them.

| Service           | Default port |
| ----------------- | ------------ |
| CAP / cockpit     | `4004`       |
| Tabular inference | `8080`       |
| Assistant         | `8081`       |
| LLM gateway       | `4000`       |

If you change `CAP_PORT`, update explicit `CAP_URL` and `CORS_ORIGINS` settings
too. Keep the Python services' loopback host defaults for local use. Startup
waits for Tabular readiness, automatically runs the existing `prepareDay` batch,
and waits for its published generation. Missing predictions use the configured
live provider and can incur costs. Exact unchanged input reuses its load and
prepared generation. Demo-priority history and synthetic requisition seeding
remain disabled. Unavailable estimates are reported, not replaced with fixtures.

### Stored predictions

The TabPFN predictions for the demo ship as Parquet in `data/demo/predictions/`
(`PredictionRun`, `PredictionResult`, and a hash manifest). After source intake,
`npm start` imports them into the CAP prediction cache and re-keys them to the
configured tabular backend. `prepareDay` then derives the cockpit locally:
requests identical to stored ones make no provider calls; anything else (other
source data or `TIDE_AS_OF`) is predicted live. The loader ignores this folder.
`npm run setup` reports whether stored predictions are present.

To recompute the predictions with the live provider (this can incur costs):

```sh
TIDE_RECOMPUTE=1 npm start   # skip the import, force a fresh prepareDay
npm run data:seed            # once it's ready: export to data/demo/predictions/
```

Use `TIDE_RECOMPUTE=1` for a single run, not in `.env`; otherwise every start
recomputes.

## Usage

| Command                            | What it does                                                            |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `npm run setup`                    | Install frozen app dependencies and build assistant assets.             |
| `npm run doctor`                   | Check local configuration and provisioned-data prerequisites.           |
| `npm start`                        | Import source, prepare predictions, and run services in the foreground. |
| `npm test -- cap`                  | Run CAP lint, typecheck, and tests.                                     |
| `npm test -- assistant`            | Run assistant typecheck and tests.                                      |
| `npm test -- agent tabular loader` | Run the selected Python projects' lint, type checks, and offline tests. |
| `npm test`                         | Run every test target.                                                  |
| `npm run data:load`                | Verify and import source only, without provider calls.                  |
| `npm run data:seed`                | Export the TabPFN predictions to `<dataset>/predictions/*.parquet`.     |

Pick the target you've changed rather than running everything.
`npm start -- --help` shows the command summary without launching services.
Application tests use offline adapters.

## Research

The [research report](research/RESEARCH.md) contains the experiment protocols,
results, and figures; customer data is not included. In a pre-registered
comparison using two years of one industrial company's SAP data, untuned
TabPFN-3.5 had a lower mean absolute lead-time error than tuned LightGBM:
**5.8 versus 6.3 days**. Its nominal **80% lead-time ranges covered 87.7%** of
observed values, about 88%. These intervals are the basis for the app's arrival
ranges, but their coverage in the study does not establish calibration in the app.

At 90% test-set accuracy, TabPFN covered **8.5 percentage points more
account-assignment requests** and **10.6 points more material-group requests**
than tuned LightGBM. This measures the potential for pre-filling more requests
at equal accuracy, not a validated production acceptance threshold.

The report also records where TabPFN didn't improve on a baseline. Exact scores
and a separate public-data replication are summarized below:

| Experiment                     | Result                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| SAP lead time, pooled history  | TabPFN MAE **5.76 days**, versus **6.32** for tuned LightGBM; paired effect **0.56 [0.35, 0.77] days**.             |
| SAP free-text coding           | Account-assignment accuracy **83.2% versus 80.2%**; material-group accuracy **67.9% versus 62.5%**.                 |
| Public USAspending replication | TabPFN met the registered win rule on all three tasks, though recipient prediction remained weak in absolute terms. |

These are benchmark results, not measurements of the rebuilt app. The SAP study
uses one company's export, excludes unresolved deliveries from scoring, and
can't be rerun without confidential data. Test-set oracle coverage is not a
deployable auto-accept threshold.

You can inspect the figures without running the app. See
[reproducibility and figure generation](research/RESEARCH.md#reproducibility-and-figure-generation)
for which artifacts can be reproduced from this repository.

## License

cbs TIDE is licensed under the **Apache License 2.0**. See [LICENSE](LICENSE)
for the full terms.

Third-party dependencies and materials remain subject to their own licenses and
terms. This license does not grant trademark rights to the cbs or SAP names and
logos, or access to customer data or paid inference services.
