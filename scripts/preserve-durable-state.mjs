import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const ignored = new Set([
  "node_modules",
  ".venv",
  ".git",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cds",
  "graphify-out",
  "dist",
  "gen",
  "@cds-models",
  ".ui5-tooling-modules",
  ".ui5-tooling-cache",
]);
const inside = (parent, filename) =>
  filename === parent || filename.startsWith(`${parent}${path.sep}`);
const hashFile = async (filename) => {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
};

export async function backupDatabase(source, destination) {
  assert.ok(!fs.existsSync(destination), "Backup destination already exists");
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const input = new DatabaseSync(source, { readOnly: true });
  let output;
  try {
    input.exec("PRAGMA busy_timeout=5000; BEGIN");
    const schema = input
      .prepare(
        "SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name",
      )
      .all();
    const tables = schema.filter((entry) => entry.type === "table");
    const counts = Object.fromEntries(
      tables.map(({ name }) => [
        name,
        input.prepare(`SELECT count(*) AS total FROM ${quote(name)}`).get()
          .total,
      ]),
    );
    await backup(input, destination);
    fs.chmodSync(destination, 0o600);
    output = new DatabaseSync(destination, { readOnly: true });
    assert.deepEqual(
      output
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
    assert.deepEqual(
      output
        .prepare(
          "SELECT name, type, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name",
        )
        .all(),
      schema,
      "Backup schema differs from the pinned source snapshot",
    );
    for (const [name, count] of Object.entries(counts))
      assert.equal(
        output.prepare(`SELECT count(*) AS total FROM ${quote(name)}`).get()
          .total,
        count,
        `Backup row count differs: ${name}`,
      );
    return { tables: counts, integrity: "ok", method: "sqlite-online-backup" };
  } finally {
    output?.close();
    if (input.isTransaction) input.exec("ROLLBACK");
    input.close();
  }
}

export async function preserveState(sourceArgument, destinationArgument) {
  const source = fs.realpathSync(sourceArgument);
  const destination = path.resolve(destinationArgument);
  assert.ok(
    !inside(source, destination),
    "Backup must be outside the source directory",
  );
  assert.ok(
    !fs.existsSync(destination),
    "Backup directory already exists; choose a new destination",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  assert.ok(
    !inside(source, fs.realpathSync(path.dirname(destination))),
    "Backup parent resolves inside the source directory",
  );
  fs.mkdirSync(destination, { mode: 0o700 });
  const manifest = {
    version: 1,
    source,
    destination,
    startedAt: new Date().toISOString(),
    consistency:
      "per-database committed snapshot; not a cross-database transaction",
    status: "running",
    files: [],
  };
  const save = () =>
    fs.writeFileSync(
      path.join(destination, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
  save();
  async function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(source, filename);
      const durableDirectory = relative
        .split(path.sep)
        .some((part) => [".data", "backups", "history"].includes(part));
      const databaseName = /\.(sqlite|sqlite3|db)([.-]|$)|\.bak([.-]|$)/i.test(
        entry.name,
      );
      if (entry.isSymbolicLink()) {
        assert.ok(
          !durableDirectory && !databaseName,
          `Durable symlink needs explicit preservation: ${relative}`,
        );
        continue;
      }
      if (entry.isDirectory()) {
        await visit(filename);
        continue;
      }
      if (!entry.isFile() || (!durableDirectory && !databaseName)) continue;
      if (/-(wal|shm)$/.test(entry.name)) {
        assert.ok(
          fs.existsSync(filename.replace(/-(wal|shm)$/, "")),
          `Orphan SQLite sidecar needs recovery: ${relative}`,
        );
        continue;
      }
      const stat = fs.statSync(filename);
      const header = Buffer.alloc(16);
      const descriptor = fs.openSync(filename, "r");
      try {
        fs.readSync(descriptor, header, 0, header.length, 0);
      } finally {
        fs.closeSync(descriptor);
      }
      const target = path.join(destination, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      let details;
      if (header.toString() === "SQLite format 3\0") {
        details = await backupDatabase(filename, target);
      } else {
        assert.ok(
          !databaseName ||
            stat.size === 0 ||
            /\.(gz|zip|tar|tgz)$/i.test(entry.name),
          `Unrecognized database/backup format: ${relative}`,
        );
        fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
        const after = fs.statSync(filename);
        assert.equal(
          after.size,
          stat.size,
          `History file changed during copy: ${relative}`,
        );
        assert.equal(
          after.mtimeMs,
          stat.mtimeMs,
          `History file changed during copy: ${relative}`,
        );
        assert.equal(
          await hashFile(filename),
          await hashFile(target),
          `History copy differs: ${relative}`,
        );
        details = {
          method:
            stat.size === 0 && databaseName
              ? "empty-placeholder"
              : "verified-file-copy",
        };
      }
      manifest.files.push({
        source: relative,
        capturedAt: new Date().toISOString(),
        bytes: fs.statSync(target).size,
        sha256: await hashFile(target),
        ...details,
      });
      save();
    }
  }
  try {
    await visit(source);
    manifest.status = "completed";
    manifest.completedAt = new Date().toISOString();
    save();
    return manifest;
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    save();
    throw error;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [source, destination, ...extra] = process.argv.slice(2);
  assert.ok(
    source && destination && extra.length === 0,
    "Usage: node scripts/preserve-durable-state.mjs <source-directory> <new-backup-directory>",
  );
  const manifest = await preserveState(source, destination);
  console.log(
    JSON.stringify({
      destination: manifest.destination,
      status: manifest.status,
      databases: manifest.files.filter(
        (file) => file.method === "sqlite-online-backup",
      ).length,
      files: manifest.files.length,
      bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
    }),
  );
}
