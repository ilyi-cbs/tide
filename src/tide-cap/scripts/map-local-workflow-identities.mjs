import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [argument, mode, ...extra] = process.argv.slice(2);
assert.ok(argument && (!mode || mode === '--apply') && !extra.length,
  'Usage: node scripts/map-local-workflow-identities.mjs <rehearsed-copy.sqlite> [--apply]');
const target = realpathSync(argument);
assert.ok(target.startsWith(`${realpathSync('/tmp')}/`), 'Identity mapping requires a disposable copy under /tmp');
const database = new DatabaseSync(target, { readOnly: mode !== '--apply' });
const version = 'workflow-identities-v1';
const mappingTable = '__tide_workflow_identities';
const ledgerTable = '__tide_workflow_identity_migrations';
const roots = { Case: 'tide_cockpit_Cases', Action: 'tide_cockpit_Actions' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const quote = name => `"${name.replaceAll('"', '""')}"`;
const rows = name => database.prepare(`SELECT * FROM ${quote(name)}`).all();
const fingerprint = records => createHash('sha256')
  .update(JSON.stringify(records.map(record => JSON.stringify(record)).sort())).digest('hex');
let transaction = false;

try {
  database.exec('PRAGMA busy_timeout = 5000');
  if (mode === '--apply') {
    database.exec('BEGIN IMMEDIATE');
    transaction = true;
  }
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
  assert.ok(tables.has('__tide_local_schema_migrations'), 'A committed schema rehearsal is required');
  const rehearsals = database.prepare("SELECT * FROM __tide_local_schema_migrations WHERE state = 'committed'").all();
  assert.ok(rehearsals.length, 'A committed schema rehearsal is required');
  for (const rehearsal of rehearsals)
    assert.notEqual(realpathSync(rehearsal.sourcePath), target, 'Cannot map identities in the original database');
  for (const table of Object.values(roots)) assert.ok(tables.has(table), `Missing retained root: ${table}`);

  const retained = Object.fromEntries(Object.entries(roots).map(([owner, table]) => [owner, rows(table)]));
  const rootIDs = Object.fromEntries(Object.entries(retained).map(([owner, records]) => [owner, new Set(records.map(row => row.ID))]));
  const baseline = Object.fromEntries(Object.entries(retained).map(([owner, records]) => [owner, { count: records.length, hash: fingerprint(records) }]));
  baseline.rehearsals = rehearsals.map(({ version, sourcePath, modelHash }) => ({ version, sourcePath, modelHash }))
    .sort((first, second) => first.version.localeCompare(second.version));
  const linkTable = 'tide_cockpit_CaseActions';
  assert.ok(tables.has(linkTable), 'Missing retained Case/Action links');
  const links = rows(linkTable);
  for (const link of links) {
    assert.ok(rootIDs.Case.has(link.header_ID), `Orphan Case/Action Case reference: ${link.header_ID}`);
    assert.ok(rootIDs.Action.has(link.action_ID), `Orphan Case/Action Action reference: ${link.action_ID}`);
  }
  baseline.links = { count: links.length, hash: fingerprint(links) };
  const previous = tables.has(ledgerTable)
    ? database.prepare(`SELECT * FROM ${quote(ledgerTable)} WHERE version = ?`).get(version) : null;
  if (previous) {
    assert.equal(previous.state, 'committed', 'Incomplete identity mapping requires investigation');
    assert.deepEqual(JSON.parse(previous.baseline), baseline, 'Retained roots or links changed since identity mapping');
  }

  const existing = tables.has(mappingTable) ? rows(mappingTable) : [];
  const mappings = new Map();
  const canonical = new Set();
  for (const mapping of existing) {
    assert.ok(roots[mapping.owner], `Unknown mapped owner: ${mapping.owner}`);
    assert.ok(rootIDs[mapping.owner].has(mapping.legacyID), `Mapped legacy root is missing: ${mapping.legacyID}`);
    assert.match(mapping.canonicalID, uuid, 'Invalid mapped UUID');
    const key = JSON.stringify([mapping.owner, mapping.legacyID]);
    const canonicalKey = JSON.stringify([mapping.owner, mapping.canonicalID.toLowerCase()]);
    assert.ok(!mappings.has(key) && !canonical.has(canonicalKey), 'Ambiguous retained identity mapping');
    if (uuid.test(mapping.legacyID))
      assert.equal(mapping.canonicalID, mapping.legacyID, 'Existing UUID identity must remain unchanged');
    mappings.set(key, mapping);
    canonical.add(canonicalKey);
  }
  const planned = [];
  for (const [owner, records] of Object.entries(retained)) {
    for (const record of records) {
      assert.ok(typeof record.ID === 'string' && record.ID.length, 'Retained root has no identity');
      const key = JSON.stringify([owner, record.ID]);
      if (mappings.has(key)) continue;
      assert.ok(!previous, `Committed mapping is incomplete: ${owner}/${record.ID}`);
      const canonicalID = uuid.test(record.ID) ? record.ID : randomUUID();
      const canonicalKey = JSON.stringify([owner, canonicalID.toLowerCase()]);
      assert.ok(!canonical.has(canonicalKey), `Canonical UUID collision: ${owner}/${canonicalID}`);
      const mapping = { owner, legacyID: record.ID, canonicalID };
      planned.push(mapping);
      mappings.set(key, mapping);
      canonical.add(canonicalKey);
    }
  }

  if (mode === '--apply' && !previous) {
    database.exec(`CREATE TABLE IF NOT EXISTS ${quote(mappingTable)} (
      owner TEXT NOT NULL, legacyID TEXT NOT NULL, canonicalID TEXT NOT NULL,
      PRIMARY KEY (owner, legacyID), UNIQUE (owner, canonicalID)
    )`);
    database.exec(`CREATE TABLE IF NOT EXISTS ${quote(ledgerTable)} (
      version TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL,
      baseline TEXT NOT NULL, completedAt TEXT NOT NULL
    )`);
    const insert = database.prepare(`INSERT INTO ${quote(mappingTable)} (owner, legacyID, canonicalID) VALUES (?, ?, ?)`);
    for (const mapping of planned) insert.run(mapping.owner, mapping.legacyID, mapping.canonicalID);
    for (const [owner, table] of Object.entries(roots))
      assert.equal(fingerprint(rows(table)), baseline[owner].hash, `Retained content changed: ${table}`);
    assert.equal(fingerprint(rows(linkTable)), baseline.links.hash, 'Retained links changed');
    database.prepare(`INSERT INTO ${quote(ledgerTable)} (version, state, baseline, completedAt) VALUES (?, ?, ?, ?)`)
      .run(version, 'committed', JSON.stringify(baseline), new Date().toISOString());
  }
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  if (transaction) {
    database.exec('COMMIT');
    transaction = false;
  }
  console.log(JSON.stringify({ target, version,
    state: previous ? 'already_applied' : mode === '--apply' ? 'mapped' : 'planned',
    identities: mappings.size, newIdentities: planned.length, retained: baseline,
    targetRootsMigrated: false, referencesRewritten: false }, null, 2));
} catch (error) {
  if (transaction) database.exec('ROLLBACK');
  throw error;
} finally {
  database.close();
}