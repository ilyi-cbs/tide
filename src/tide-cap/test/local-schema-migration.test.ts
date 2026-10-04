import assert from "node:assert/strict";
import cds from "@sap/cds";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const root = path.resolve(__dirname, "..");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const history = [
  "Cases",
  "Actions",
  "ActionItems",
  "CaseActions",
  "CaseEvents",
  "ActionEvents",
  "FreetextSubmission",
];

async function populatedLegacyDatabase(filename: string) {
  const model = await cds.load("*");
  const database = new DatabaseSync(filename);
  for (const statement of cds.compile.to.sql(model)) database.exec(statement);
  const insert = (entity: string, row: Record<string, unknown>) => {
    const fields = Object.keys(row);
    database
      .prepare(
        `INSERT INTO ${quote("tide_cockpit_" + entity)}
      (${fields.map(quote).join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
      )
      .run(...(Object.values(row) as Array<string | number | null>));
  };
  const actionID = "00000000-0000-4000-8000-000000000001";
  const caseID = "opaque-legacy-case:exact/id";
  insert("Cases", {
    ID: caseID,
    kind: "requisition_review",
    status: "open",
    Plant: "DE11",
    PurchasingGroup: "D01",
  });
  insert("Actions", {
    ID: actionID,
    operationKey: "requisition_review",
    kind: "pr_review",
    status: "waiting",
    decidedBy: "buyerD01",
  });
  insert("ActionItems", {
    ID: "00000000-0000-4000-8000-000000000002",
    action_ID: actionID,
    objectKey: "1000000001/00010",
    field: "PurchasingGroup",
    oldValue: "D01",
    newValue: "D02",
    data: '{"approved":"immutable"}',
  });
  insert("CaseActions", {
    header_ID: caseID,
    action_ID: actionID,
    operation: "requisition_review",
  });
  insert("CaseEvents", {
    ID: "00000000-0000-4000-8000-000000000003",
    header_ID: caseID,
    event: "action_prepared",
    actor: "buyerD01",
  });
  insert("ActionEvents", {
    ID: "00000000-0000-4000-8000-000000000004",
    action_ID: actionID,
    event: "approved",
    actor: "buyerD01",
  });
  insert("FreetextSubmission", {
    ID: "00000000-0000-4000-8000-000000000005",
    action_ID: actionID,
    PurchaseRequisition: "1000000001",
    PurchaseRequisitionItem: "00010",
    sourceRevision: 1,
    submittedBy: "buyerD01",
    payload: '{"completed":{"PurchasingGroup":"D02"},"explicitClear":null}',
  });
  for (const view of database
    .prepare("SELECT name FROM sqlite_schema WHERE type='view'")
    .all())
    database.exec(`DROP VIEW ${quote(String(view.name))}`);
  database.exec("DROP TABLE tide_workflow_ReviewEvents");
  database.exec("ALTER TABLE tide_cockpit_CaseEvents DROP COLUMN command_ID");
  database.exec("ALTER TABLE tide_cockpit_ActionEvents DROP COLUMN command_ID");
  database.close();
}

function snapshot(filename: string) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return Object.fromEntries(
      history.map((entity) => {
        const table = "tide_cockpit_" + entity;
        const fields = database
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((column) => String(column.name));
        return [
          table,
          {
            fields,
            rows: database
              .prepare(
                `SELECT ${fields.map(quote).join(",")} FROM ${quote(table)}`,
              )
              .all(),
          },
        ];
      }),
    );
  } finally {
    database.close();
  }
}

function migrate(
  source: string,
  target: string,
  options: string[] = [],
  fault = false,
) {
  return spawnSync(
    process.execPath,
    ["scripts/rehearse-local-schema.mjs", source, target, ...options],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_ENV: "test",
        TIDE_LOCAL_SCHEMA_TEST_EXIT: fault ? "before_commit" : "",
      },
    },
  );
}

test("populated local migration resumes after process exit and preserves exact history and opaque references", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tide-migration-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "copy.sqlite");
  try {
    await populatedLegacyDatabase(source);
    const before = snapshot(source);
    assert.ok(Object.values(before).every((record) => record.rows.length > 0));
    const interrupted = migrate(source, target, [], true);
    assert.equal(interrupted.status, 71, interrupted.stderr);
    const recovered = new DatabaseSync(target);
    assert.equal(
      recovered
        .prepare("SELECT state FROM __tide_local_schema_migrations")
        .get()?.state,
      "planned",
    );
    assert.equal(
      recovered
        .prepare(
          "SELECT count(*) AS total FROM sqlite_schema WHERE name='tide_workflow_ReviewEvents'",
        )
        .get()?.total,
      0,
    );
    recovered.close();
    const resumed = migrate(source, target, ["--resume"]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const result = JSON.parse(resumed.stdout);
    assert.equal(result.state, "committed");
    assert.equal(result.integrity, "ok");
    assert.equal(result.newTables, 1);
    assert.equal(result.addedColumns, 2);
    const migrated = new DatabaseSync(target, { readOnly: true });
    for (const [table, record] of Object.entries(before))
      assert.deepEqual(
        migrated
          .prepare(
            `SELECT ${record.fields.map(quote).join(",")} FROM ${quote(table)}`,
          )
          .all(),
        record.rows,
      );
    assert.equal(
      migrated
        .prepare(
          `SELECT count(*) AS total FROM tide_cockpit_CaseActions AS links
      LEFT JOIN tide_cockpit_Cases AS cases ON cases.ID=links.header_ID
      LEFT JOIN tide_cockpit_Actions AS actions ON actions.ID=links.action_ID
      WHERE cases.ID IS NULL OR actions.ID IS NULL`,
        )
        .get()?.total,
      0,
    );
    assert.equal(
      migrated
        .prepare(
          `SELECT count(*) AS total FROM tide_cockpit_FreetextSubmission AS submissions
      LEFT JOIN tide_cockpit_Actions AS actions ON actions.ID=submissions.action_ID WHERE actions.ID IS NULL`,
        )
        .get()?.total,
      0,
    );
    migrated.close();
    const repeat = migrate(source, target, ["--resume"]);
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.equal(JSON.parse(repeat.stdout).state, "already_applied");
    assert.deepEqual(snapshot(source), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("publication schema migration preserves retained runs without inventing history or a current pointer", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "tide-publication-migration-"),
  );
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "copy.sqlite");
  const publicationTables = [
    "PreparationPhase",
    "PublishedCockpit",
    "CaseObservation",
    "ExposureObservation",
  ];
  const publicationColumns = [
    "sourceLoadedAt",
    "source",
    "policyVersion",
    "publishedAt",
    "completeness",
    "workerToken",
    "observationType",
  ];
  const ID = cds.utils.uuid();
  try {
    await populatedLegacyDatabase(source);
    const legacy = new DatabaseSync(source);
    legacy
      .prepare(
        "INSERT INTO tide_cockpit_Snapshot (ID, asOf, status, revenueAtRiskP80, message) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ID, "2026-10-05", "done", 200, "Retained preparation");
    for (const entity of publicationTables)
      legacy.exec(`DROP TABLE ${quote("tide_cockpit_" + entity)}`);
    for (const column of publicationColumns)
      legacy.exec(
        `ALTER TABLE tide_cockpit_Snapshot DROP COLUMN ${quote(column)}`,
      );
    const fields = legacy
      .prepare("PRAGMA table_info(tide_cockpit_Snapshot)")
      .all()
      .map((column) => String(column.name));
    const beforeRun = legacy
      .prepare(
        `SELECT ${fields.map(quote).join(",")} FROM tide_cockpit_Snapshot`,
      )
      .all();
    legacy.close();
    const beforeWorkflow = snapshot(source);
    const migrated = migrate(source, target);
    assert.equal(migrated.status, 0, migrated.stderr);
    const result = JSON.parse(migrated.stdout);
    assert.equal(result.integrity, "ok");
    assert.equal(result.newTables, 5);
    assert.equal(result.addedColumns, 9);
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      assert.deepEqual(
        copy
          .prepare(
            `SELECT ${fields.map(quote).join(",")} FROM tide_cockpit_Snapshot`,
          )
          .all(),
        beforeRun,
      );
      const run = copy
        .prepare("SELECT * FROM tide_cockpit_Snapshot WHERE ID = ?")
        .get(ID);
      for (const column of publicationColumns)
        assert.equal(run?.[column], null);
      for (const entity of publicationTables)
        assert.equal(
          copy
            .prepare(
              `SELECT count(*) AS total FROM ${quote("tide_cockpit_" + entity)}`,
            )
            .get()?.total,
          0,
        );
    } finally {
      copy.close();
    }
    assert.deepEqual(snapshot(source), beforeWorkflow);
    const unchanged = new DatabaseSync(source, { readOnly: true });
    try {
      assert.deepEqual(
        unchanged
          .prepare(
            `SELECT ${fields.map(quote).join(",")} FROM tide_cockpit_Snapshot`,
          )
          .all(),
        beforeRun,
      );
      assert.equal(
        unchanged
          .prepare(
            "SELECT count(*) AS total FROM sqlite_schema WHERE name='tide_cockpit_PublishedCockpit'",
          )
          .get()?.total,
        0,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("subject claims nullability migration is opt-in and preserves claims and retained history", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tide-claims-migration-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "copy.sqlite");
  const table = "tide_workflow_SubjectClaims";
  try {
    await populatedLegacyDatabase(source);
    const legacy = new DatabaseSync(source);
    legacy.exec(`ALTER TABLE ${quote(table)} DROP COLUMN caseID`);
    const ddl = String(
      legacy.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(table)
        ?.sql,
    );
    assert.ok(ddl.includes("actionID NVARCHAR(36),"));
    legacy.exec(`DROP TABLE ${quote(table)}`);
    legacy.exec(
      ddl.replace("actionID NVARCHAR(36),", "actionID NVARCHAR(36) NOT NULL,"),
    );
    legacy
      .prepare(`INSERT INTO ${quote(table)} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "tenant",
        "source",
        "requisition",
        "1000000001/00010",
        "action",
        "review",
        "action-1",
        "command-1",
      );
    legacy.exec(
      `CREATE INDEX retained_claim_action ON ${quote(table)} (actionID)`,
    );
    const fields = legacy
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((column) => String(column.name));
    const claims = legacy
      .prepare(`SELECT ${fields.map(quote).join(",")} FROM ${quote(table)}`)
      .all();
    legacy.close();
    const before = snapshot(source);
    const denied = migrate(source, path.join(directory, "denied.sqlite"));
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /changed nullability/);
    const migrated = migrate(source, target, [
      "--allow-subject-claim-action-null",
    ]);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.deepEqual(JSON.parse(migrated.stdout).rebuiltTables, [table]);
    const copy = new DatabaseSync(target);
    try {
      assert.deepEqual(
        copy
          .prepare(`SELECT ${fields.map(quote).join(",")} FROM ${quote(table)}`)
          .all(),
        claims,
      );
      assert.equal(
        copy
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .find((column) => column.name === "actionID")?.notnull,
        0,
      );
      assert.equal(
        copy.prepare(`SELECT caseID FROM ${quote(table)}`).get()?.caseID,
        null,
      );
      assert.equal(
        copy
          .prepare(
            "SELECT count(*) AS total FROM sqlite_schema WHERE name='retained_claim_action'",
          )
          .get()?.total,
        1,
      );
      copy
        .prepare(
          `INSERT INTO ${quote(table)} (tenant, sourceSystem, kind, subjectKey, claimType, slot, actionID, caseID, commandID) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "tenant",
          "source",
          "requisition",
          "1000000001/00020",
          "case",
          "review",
          null,
          "case-1",
          "command-2",
        );
    } finally {
      copy.close();
    }
    assert.deepEqual(snapshot(source), before);
    assert.equal(
      migrate(source, target, ["--resume", "--allow-subject-claim-action-null"])
        .status,
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migration rejects changed keys, unowned existing targets and source symlinks without changing source", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "tide-migration-denial-"));
  const source = path.join(directory, "source.sqlite");
  try {
    await populatedLegacyDatabase(source);
    const before = snapshot(source);
    assert.notEqual(migrate(source, source, ["--resume"]).status, 0);
    const alias = path.join(directory, "source-alias.sqlite");
    symlinkSync(source, alias);
    assert.notEqual(migrate(source, alias, ["--resume"]).status, 0);
    assert.notEqual(migrate(source, source, []).status, 0);
    const unowned = path.join(directory, "unowned.sqlite");
    await populatedLegacyDatabase(unowned);
    const unownedBefore = snapshot(unowned);
    assert.notEqual(migrate(source, unowned, ["--resume"]).status, 0);
    assert.deepEqual(snapshot(unowned), unownedBefore);
    const database = new DatabaseSync(source);
    database.exec(
      "ALTER TABLE tide_cockpit_Cases RENAME COLUMN ID TO legacy_ID",
    );
    database.close();
    const denied = migrate(source, path.join(directory, "denied.sqlite"));
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /changed keys/);
    const after = snapshot(source);
    assert.deepEqual(after.tide_cockpit_Actions, before.tide_cockpit_Actions);
    assert.equal(
      after.tide_cockpit_Cases.rows[0].legacy_ID,
      before.tide_cockpit_Cases.rows[0].ID,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
