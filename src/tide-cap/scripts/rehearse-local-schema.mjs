import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import cds from "@sap/cds";

const [sourceArgument, targetArgument, ...options] = process.argv.slice(2);
if (!sourceArgument || !targetArgument) {
  throw new Error(
    "Usage: node scripts/rehearse-local-schema.mjs <source.sqlite> <copy.sqlite> [--resume] [--version=local-lifecycle-vN] [--allow-subject-claim-action-null]",
  );
}
assert.ok(
  options.every(
    (option) =>
      option === "--resume" ||
      option === "--allow-subject-claim-action-null" ||
      /^--version=local-lifecycle-v[1-9][0-9]*$/.test(option),
  ),
  "Unknown migration option",
);
assert.ok(
  options.filter((option) => option.startsWith("--version=")).length <= 1,
  "Only one migration version may be specified",
);
const resume = options.includes("--resume");
const allowSubjectClaimActionNull = options.includes(
  "--allow-subject-claim-action-null",
);
const sourcePath = realpathSync(sourceArgument);
const targetPath = path.resolve(targetArgument);
const targetExisted = existsSync(targetPath);
assert.notEqual(
  sourcePath,
  targetExisted ? realpathSync(targetPath) : targetPath,
  "The source database cannot be the migration target",
);
assert.ok(
  resume || !existsSync(targetPath),
  "The target must be a new database copy; use --resume explicitly",
);
const version =
  options
    .find((option) => option.startsWith("--version="))
    ?.slice("--version=".length) ?? "local-lifecycle-v1";
const ledger = "__tide_local_schema_migrations";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const schema = (database) =>
  database
    .prepare(
      "SELECT name, type, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    )
    .all();
const columns = (database, name) =>
  database.prepare(`PRAGMA table_info(${quote(name)})`).all();
const fingerprint = (database, name, selectedColumns) => {
  const rows = database
    .prepare(
      `SELECT ${selectedColumns.map(quote).join(",")} FROM ${quote(name)}`,
    )
    .all();
  const serialized = rows.map((row) => JSON.stringify(row)).sort();
  return {
    count: rows.length,
    hash: createHash("sha256").update(JSON.stringify(serialized)).digest("hex"),
  };
};

const model = await cds.load("*");
const reference = new DatabaseSync(":memory:");
for (const statement of cds.compile.to.sql(model, { dialect: "sqlite" }))
  reference.exec(statement);
if (!existsSync(targetPath)) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const input = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    input.exec("PRAGMA busy_timeout = 5000");
    await backup(input, targetPath);
  } finally {
    input.close();
  }
}
const source = new DatabaseSync(targetPath, { readOnly: true });
source.exec("PRAGMA busy_timeout = 5000");
const existing = schema(source);
const existingTables = new Map(
  existing
    .filter((entry) => entry.type === "table")
    .map((entry) => [entry.name, entry]),
);
const resumable = existingTables.has(ledger)
  ? source
      .prepare(`SELECT * FROM ${quote(ledger)} WHERE version = ?`)
      .get(version)
  : null;
assert.ok(
  !targetExisted || resumable,
  "An existing target requires its matching migration ledger",
);
const desired = schema(reference);
const additions = [];
const newTables = [];
const rebuiltTables = [];
for (const table of desired.filter((entry) => entry.type === "table")) {
  if (!existingTables.has(table.name)) {
    newTables.push(table);
    continue;
  }
  const oldColumns = columns(source, table.name);
  const desiredColumns = columns(reference, table.name);
  const oldKeys = oldColumns
    .filter((column) => column.pk)
    .sort((first, second) => first.pk - second.pk)
    .map((column) => column.name);
  const newKeys = desiredColumns
    .filter((column) => column.pk)
    .sort((first, second) => first.pk - second.pk)
    .map((column) => column.name);
  assert.deepEqual(
    newKeys,
    oldKeys,
    `Explicit migration required for changed keys: ${table.name}`,
  );
  for (const column of desiredColumns) {
    const previous = oldColumns.find((entry) => entry.name === column.name);
    if (previous) {
      assert.equal(
        column.type.toUpperCase(),
        previous.type.toUpperCase(),
        `Explicit migration required for changed type: ${table.name}.${column.name}`,
      );
      if (
        allowSubjectClaimActionNull &&
        table.name === "tide_workflow_SubjectClaims" &&
        column.name === "actionID" &&
        previous.notnull === 1 &&
        column.notnull === 0
      ) {
        assert.ok(
          oldColumns.every((oldColumn) =>
            desiredColumns.some(
              (desiredColumn) => desiredColumn.name === oldColumn.name,
            ),
          ),
          "SubjectClaims rebuild cannot discard legacy columns",
        );
        rebuiltTables.push({
          ...table,
          selectedColumns: oldColumns.map((oldColumn) => oldColumn.name),
        });
      } else {
        assert.equal(
          column.notnull,
          previous.notnull,
          `Explicit migration required for changed nullability: ${table.name}.${column.name}`,
        );
      }
      continue;
    }
    assert.equal(column.pk, 0, "A new primary key cannot be added implicitly");
    assert.match(
      column.type,
      /^[a-z_]+(?:\(\d+(?:,\d+)?\))?$/i,
      "Unsupported compiler column type",
    );
    if (column.notnull && column.dflt_value === null) {
      assert.equal(
        source
          .prepare(`SELECT COUNT(*) AS total FROM ${quote(table.name)}`)
          .get().total,
        0,
        `Required column needs an explicit backfill: ${table.name}.${column.name}`,
      );
    }
    additions.push({
      table: table.name,
      sql: `ALTER TABLE ${quote(table.name)} ADD COLUMN ${quote(column.name)} ${column.type}${column.notnull ? " NOT NULL" : ""}${column.dflt_value !== null ? ` DEFAULT ${column.dflt_value}` : ""}`,
    });
  }
}
const retained = [...existingTables.keys()]
  .filter((name) => name !== ledger)
  .map((name) => {
    const selectedColumns = columns(source, name).map((column) => column.name);
    return {
      name,
      selectedColumns,
      before: fingerprint(source, name, selectedColumns),
    };
  });
const target = new DatabaseSync(targetPath);
target.exec("PRAGMA busy_timeout = 5000");
const modelHash = createHash("sha256")
  .update(JSON.stringify(desired.map((entry) => entry.sql).sort()))
  .digest("hex");
try {
  target.exec(`CREATE TABLE IF NOT EXISTS ${quote(ledger)} (
    version TEXT PRIMARY KEY NOT NULL, sourcePath TEXT NOT NULL, modelHash TEXT NOT NULL,
    state TEXT NOT NULL, baseline TEXT NOT NULL, startedAt TEXT NOT NULL, completedAt TEXT
  )`);
  const previous = target
    .prepare(`SELECT * FROM ${quote(ledger)} WHERE version = ?`)
    .get(version);
  if (previous) {
    assert.equal(
      previous.sourcePath,
      sourcePath,
      "Resume source identity differs",
    );
    assert.equal(
      previous.modelHash,
      modelHash,
      "Model changed; an explicit new migration version is required",
    );
  }
  if (previous?.state === "committed") {
    assert.equal(newTables.length, 0, "Committed migration is missing tables");
    assert.equal(additions.length, 0, "Committed migration is missing columns");
    assert.equal(
      rebuiltTables.length,
      0,
      "Committed migration still requires a table rebuild",
    );
    assert.equal(
      target.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    console.log(
      JSON.stringify(
        {
          source: sourcePath,
          target: targetPath,
          version,
          modelHash,
          state: "already_applied",
          newTables: 0,
          addedColumns: 0,
          rebuiltTables: [],
          retained: retained.map((record) => ({
            table: record.name,
            ...record.before,
          })),
          integrity: "ok",
        },
        null,
        2,
      ),
    );
  } else {
    if (!previous)
      target
        .prepare(
          `INSERT INTO ${quote(ledger)}
    (version, sourcePath, modelHash, state, baseline, startedAt) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version,
          sourcePath,
          modelHash,
          "planned",
          JSON.stringify(retained),
          new Date().toISOString(),
        );
    const baseline = previous ? JSON.parse(previous.baseline) : retained;
    target.exec("BEGIN IMMEDIATE");
    try {
      for (const view of existing.filter((entry) => entry.type === "view"))
        target.exec(`DROP VIEW ${quote(view.name)}`);
      for (const table of newTables) target.exec(table.sql);
      for (const table of rebuiltTables) {
        const temporaryName = `__tide_migrate_${table.name}`;
        assert.ok(
          !existingTables.has(temporaryName),
          "Migration temporary table already exists",
        );
        assert.match(
          table.sql,
          /^CREATE TABLE /i,
          "Unsupported compiler table DDL",
        );
        const definitionStart = table.sql.indexOf("(");
        assert.ok(
          definitionStart > 0,
          "Compiler table DDL has no column definition",
        );
        target.exec(
          `CREATE TABLE ${quote(temporaryName)} ${table.sql.slice(definitionStart)}`,
        );
        const fields = table.selectedColumns.map(quote).join(",");
        target.exec(
          `INSERT INTO ${quote(temporaryName)} (${fields}) SELECT ${fields} FROM ${quote(table.name)}`,
        );
        target.exec(`DROP TABLE ${quote(table.name)}`);
        target.exec(
          `ALTER TABLE ${quote(temporaryName)} RENAME TO ${quote(table.name)}`,
        );
        for (const entry of existing.filter(
          (entry) =>
            entry.tbl_name === table.name &&
            ["index", "trigger"].includes(entry.type),
        ))
          target.exec(entry.sql);
      }
      for (const statement of additions.filter(
        (statement) =>
          !rebuiltTables.some((table) => table.name === statement.table),
      ))
        target.exec(statement.sql);
      const indexNames = new Set(
        schema(target)
          .filter((entry) => entry.type === "index")
          .map((entry) => entry.name),
      );
      for (const index of desired.filter(
        (entry) => entry.type === "index" && !indexNames.has(entry.name),
      ))
        target.exec(index.sql);
      for (const view of desired.filter((entry) => entry.type === "view"))
        target.exec(view.sql);
      for (const record of baseline)
        assert.deepEqual(
          fingerprint(target, record.name, record.selectedColumns),
          record.before,
          `Retained content changed: ${record.name}`,
        );
      assert.equal(
        target.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
      target
        .prepare(
          `UPDATE ${quote(ledger)} SET state = ?, completedAt = ? WHERE version = ?`,
        )
        .run("committed", new Date().toISOString(), version);
      if (
        process.env.NODE_ENV === "test" &&
        process.env.TIDE_LOCAL_SCHEMA_TEST_EXIT === "before_commit"
      )
        process.exit(71);
      target.exec("COMMIT");
      console.log(
        JSON.stringify(
          {
            source: sourcePath,
            target: targetPath,
            version,
            modelHash,
            state: "committed",
            newTables: newTables.length,
            addedColumns: additions.length,
            rebuiltTables: rebuiltTables.map((table) => table.name),
            views: desired.filter((entry) => entry.type === "view").length,
            retained: baseline.map((record) => ({
              table: record.name,
              ...record.before,
            })),
            integrity: "ok",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      target.exec("ROLLBACK");
      throw error;
    }
  }
} finally {
  target.close();
  source.close();
  reference.close();
}
