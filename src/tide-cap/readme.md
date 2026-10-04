# tide-cap

SAP CAP application for TIDE. It stores the SAP source replicas, prepares
predictions through `../tide-tabular`, hosts the purchasing desk (Fiori) and the
embedded assistant, and exposes MCP tools for `../tide-agent`. Source intake is
done by `../tide-loader`.

## Layout

- `db/`: SAP source tables, prediction runtime, assessment, publication,
  workflow and review models.
- `srv/core.*`, `srv/core/`: validated inference, persistent prediction queue
  and recovery.
- `srv/workflow-service.*`: buyer commands with trusted identity, authorization,
  stale-state guards and replay receipts.
- `srv/source-service.*`, `assessment-service.*`, `review-service.*`,
  `publication-service.*`: use-case boundaries.
- `srv/cockpit/`: daily preparation, assessment policies, cases/actions, review
  drafts, publication and read projections.
- `srv/cockpit-mcp-service.*`, `srv/assistant-runtime-service.*`: assistant tools
  and runtime support.
- `app/purchasing-desk/`, `app/assistant/`: purchasing UI and assistant.
- `scripts/`: opt-in tooling for migrating an existing local database copy.
- `test/`: offline tests (in-memory SQLite, fake tabular server).

## Service Wiring

| Service     | Endpoint                 | Current operation ownership                                                                                                          |
| ----------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source      | `/odata/v4/source/`      | Administrator-only intake; compatible source mutation routes enforce the same role.                                                  |
| Assessment  | `/odata/v4/assessment/`  | Authorized prevention reassessment with current fingerprint validation.                                                              |
| Review      | `/odata/v4/review/`      | Workflow-stage counts and receipted submission/recovery through WorkflowService. Native editing stays in the existing draft service. |
| Publication | `/odata/v4/publication/` | Explicit preparation, scoped Overview and publication history; generic Snapshot reads require administrator role.                    |

The purchasing desk uses the Publication, Assessment and Review services.
Approval and exception commands retain the Workflow model. Pending recovery
persists the command type and frozen arguments, checks the matching receipt, and
does not treat recovery of an older decision as execution of a changed decision.
Linked Action decisions and Case exceptions require the Workflow command context;
Case metadata refresh preserves kind identity and checks concurrent modification.

Agent/MCP Overview and Review submission use the Publication and Review owners.

## Lifecycle rules

Buyer writes use `WorkflowService` commands. Exact authorized retries return
the committed receipt; changed arguments or stale evidence conflict. Linked
owners' claims, state changes, events and receipt commit together.

Source condition, Case disposition/listing/attention, Action decision/outcome
and Review preparation/submission are separate. Approval, manually recorded
posting and missing source rows do not prove fulfillment. There is no automatic
supplier dispatch or SAP posting.

## Run locally

Use the root commands (`npm run setup`, `npm run data:load`, `npm start`); see
the [repository README](../../README.md). The database defaults to
`../../.data/retained/cap.sqlite`. A missing database is deployed from this
model; an existing one is never reset or redeployed automatically.

For a CAP-only startup against an already loaded database:

```sh
cd src/tide-cap
NODE_OPTIONS=--import=tsx PORT=4004 \
CDS_REQUIRES_DB_CREDENTIALS_URL=../../.data/retained/cap.sqlite \
CDS_REQUIRES_TABULAR_CREDENTIALS_URL=http://127.0.0.1:8080 \
node_modules/.bin/cds serve --with-mocks
```

The purchasing desk is at `http://localhost:4004/tide.cockpit/index.html`.
Standalone CAP finds the loader at `../tide-loader`. Development authentication
is mocked.

## Tests

From the repository root, `npm test -- cap assistant` runs lint, typecheck and
the offline tests.
