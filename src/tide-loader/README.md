# Source-Only Loader

This package verifies and imports the SAP-shaped source Parquet of a dataset into
the `tide.s4` tables of the [CAP model](../tide-cap/db/s4.cds). It is not a
workflow or assessment writer.

## Ownership

| Owner              | Loading or preparation responsibility                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Source             | Import `tide.s4` replicas, write immutable `SourceLoads` and `IngestOperations`, advance `SourcePublications`. |
| Workflow           | Preserve cases, actions, approvals, claims, and events. Intake never deletes these.                            |
| Assessment         | Existing preparation computes delivery, price, planning, settings, duplicates, and lead-time evidence.         |
| Requisition Review | Existing preparation proposes fields from imported requests; no fabricated demo inbox.                         |
| Tabular Execution  | Existing durable prediction queue executes missing batches and retains results.                                |
| Publication        | Existing preparation publishes its coherent snapshot and records actual preparation history.                   |

`DatasetInfo` is also written as a compatibility projection because the current
preparation engine still consumes it. Existing entity names and owner handlers
are retained; this loader does not prematurely rename the unfinished target
model or populate conceptual tables with fabricated records.

## Run

After `npm run setup`, configure the root `.env`:

```sh
TIDE_DB=.data/retained/cap.sqlite
CHECKPOINT_DB=.data/retained/checkpoints.sqlite
TIDE_DATASET=data/demo
TIDE_SOURCE_SYSTEM=local-demo
```

```sh
npm run data:load  # source only; no prediction calls
npm start         # same intake, then automatic live batch preparation
```

A missing database is deployed from the `src/tide-cap` model. An existing
database must already have the source-owner tables; automatic migration or
reset is deliberately not performed. Setup does not rewrite an existing `.env`.
A fresh database is for a deliberately new installation, not a workaround for
retained-history migration. The root launcher refuses occupied service ports.

The loader is self-contained in `src/tide-loader`, with its own `pyproject.toml`,
`uv.lock`, Python version and installed `loader` package. Its retained source
mappings and normalization helpers are local; no old application package is used.
It can also be invoked directly against an already deployed database:

```sh
uv run --project src/tide-loader --frozen tide-load \
  data/demo --db /absolute/path/to/database.sqlite
```

The retained read-only delta reader is `tide-load-delta DATASET --date YYYY-MM-DD`
or `--list`. It validates batch inventory, hashes, counts and keys, shares source
normalization, and emits only SAP source rows. It neither applies database writes
nor restores prepared results, synthetic history, truth rows or reset state.

`npm test -- loader` runs Ruff, the offline tests in `tests/` (intake of the
committed demo, hash/inventory rejection, delta reading) and both installed entry
points. The CAP source-schema guard compares the local mappings with the current
CDS model and the shared source-only fixture at `tests/schema.sql`. That fixture
contains schema only, including source provenance; it has no truth tables or
prepared demo rows. Regenerate it from `src/tide-cap` with:

```sh
npx cds compile db/s4.cds db/source.cds --to sql --dialect sqlite > ../tide-loader/tests/schema.sql
```

## Intake Contract

- Verify the extensionless `file_sha256` and `rows` manifest inventories for
  base source Parquet. Reject missing files, unlisted files, changed hashes,
  invalid counts, missing required source families, and missing/null keys.
- Preserve source document/item padding. Collapse exact normalized duplicates;
  reject conflicting modeled values for one source key. No arbitrary winner
  or implicit append-order precedence is selected.
- Stage normalized rows before opening the write transaction. Publish replicas,
  the compatibility marker, load provenance, ingest results, and the source
  pointer atomically. Reject a concurrent publication or changed source files.
- Use decimal conversion for numerical business inputs. Record missing columns
  and optional families in load quality; absent domains stay unavailable.
- Ignore `truth/`, `delta/`, `predictions/`, `prepared-cockpit.json`, `cockpit-history.json`, and
  generated cockpit exports. Do not import predictions, findings, approvals,
  injected defects, or made-up historical snapshots.
- Deduplicate an unchanged load by source identity, business date, source system,
  and normalization version. Restarting does not assign a new load UUID or
  automatically repeat completed preparation for that same load.

This first contract accepts only the manifest-attested demo layout with
`containsCustomerData: false`. It records `sourceType: demo` and `trusted: false`.
Computing predictions live does not promote synthetic inputs to actual data.
Operational Morning Brief remains unavailable for this source. Actual extracts
need a separately verified classification and intake contract; changing a flag
must not silently certify them.

## Prediction Preparation

The root launcher starts Tabular before CAP and enables the existing idempotent
`prepareDay` path. That path batches arrival/source ranges, price checks, setting
checks, planned delivery times, planning, and supported requisition fields, with
its existing calibration/proof work. Unsupported or insufficient-context values
remain unavailable; the loader does not invent them or perform extra interactive
predictions for hypothetical questions.

Readiness waits for a published snapshot of the loaded source. Required phase
failures fail startup; degraded completeness is logged explicitly. Live calls
may incur provider costs. `TIDE_PREPARE_TIMEOUT_MS` defaults to one hour.
Provider retries, budgets, caching, and execution concurrency remain owned by
the existing prediction engine.

## Demo Coverage

The committed demo loads without key conflicts. It omits a few SAP families and
columns (company-code accounting, cost centers, requisition texts, some
requisition-item fields), so the load reports `accounting` and `requisition`
readiness as unavailable and `prevention` as partial. These gaps are recorded in
the load quality rather than filled with invented values.
