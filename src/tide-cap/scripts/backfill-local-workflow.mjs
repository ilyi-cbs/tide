import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';


const [argument, mode] = process.argv.slice(2);
assert.ok(argument && (!mode || mode === '--apply'), 'Usage: node scripts/backfill-local-workflow.mjs <rehearsed-copy.sqlite> [--apply]');
const target = realpathSync(argument);
assert.ok(target.startsWith(`${realpathSync('/tmp')}/`), 'Backfill is restricted to disposable copies under /tmp');
const database = new DatabaseSync(target, { readOnly: mode !== '--apply' });
const version = 'local-workflow-claims-v1';
const entities = {
  delivery: 'DeliveryRisks',
  price: 'PriceDeviations',
  duplicate: 'DuplicateMaterials',
  unusual_setting: 'UnusualSettings',
  supplier_planned_time: 'SupplierPlannedTimes',
  material_planned_time: 'MaterialPlannedTimes',
  requisition_review: 'RequisitionReviews',
};
const quote = name => `"${name.replaceAll('"', '""')}"`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = name => database.prepare(`SELECT * FROM ${quote(name)}`).all();
const caseTable = 'tide_cockpit_Cases';
const actionTable = 'tide_cockpit_Actions';
const linkTable = 'tide_cockpit_CaseActions';
const claimTable = 'tide_workflow_SubjectClaims';
const commandTable = 'tide_workflow_WorkflowCommands';
const ledger = '__tide_local_workflow_backfills';

try {
  database.exec('PRAGMA busy_timeout = 5000');
  const rehearsal = database.prepare('SELECT * FROM __tide_local_schema_migrations WHERE version = ?').get('local-lifecycle-v1');
  assert.equal(rehearsal?.state, 'committed', 'A committed schema rehearsal is required');
  assert.notEqual(realpathSync(rehearsal.sourcePath), target, 'Cannot backfill the original database');
  if (mode === '--apply') database.exec('BEGIN IMMEDIATE');
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  const previous = tables.includes(ledger)
    ? database.prepare(`SELECT * FROM ${quote(ledger)} WHERE version = ?`).get(version) : null;
  if (previous) {
    assert.equal(previous.state, 'committed', 'Incomplete backfill requires investigation');
    if (mode === '--apply') database.exec('COMMIT');
    console.log(JSON.stringify({ target, version, state: 'already_applied', result: JSON.parse(previous.result) }, null, 2));
  } else {
    const preserved = tables.filter(name => ![claimTable, commandTable, ledger].includes(name));
    const fingerprint = name => hash(rows(name).map(row => JSON.stringify(row)).sort());
    const baseline = Object.fromEntries(preserved.map(name => [name, fingerprint(name)]));
    const headers = rows(caseTable);
    const actions = new Map(rows(actionTable).map(action => [action.ID, action]));
    const links = rows(linkTable);
    const claims = new Map();
    const propose = (identity, header, action) => {
      const key = JSON.stringify(identity);
      const owner = { ...identity, caseID: header.ID, actionID: action?.ID ?? null };
      const existing = claims.get(key);
      assert.ok(!existing || (existing.caseID === owner.caseID && existing.actionID === owner.actionID), `Ambiguous historical ownership: ${key}`);
      claims.set(key, owner);
    };
    for (const header of headers) {
      const activeActions = links.filter(link => link.header_ID === header.ID)
        .map(link => actions.get(link.action_ID))
        .filter(action => action && ['needs_decision', 'waiting'].includes(action.status));
      if (header.status !== 'open' && !activeActions.length) continue;
      assert.ok(entities[header.kind], `Unsupported active Case kind: ${header.kind}`);
      const detail = database.prepare(`SELECT * FROM ${quote(`tide_cockpit_${entities[header.kind]}`)} WHERE header_ID = ?`).get(header.ID);
      assert.ok(detail, `Missing source identity for ${header.ID}`);
      let kind;
      let subjects;
      let field;
      switch (header.kind) {
        case 'delivery':
          kind = 'PurchaseOrderItem'; subjects = [[detail.PurchaseOrder, detail.PurchaseOrderItem]]; field = 'delivery_follow_up'; break;
        case 'price':
          kind = 'PurchasingPriceContext'; subjects = [[detail.Material, detail.Supplier, detail.Plant]]; field = 'price_clarification'; break;
        case 'duplicate':
          kind = 'MaterialPlant'; subjects = [...new Set(String(detail.materialNumbers ?? '').split(',').map(value => value.trim()).filter(Boolean))].sort().map(material => [material, detail.Plant]); field = 'duplicate_review'; break;
        case 'unusual_setting':
          kind = 'MaterialPlant'; subjects = [[detail.Material, detail.Plant]]; field = 'planning_setting_review'; break;
        case 'material_planned_time':
          kind = 'MaterialPlant'; subjects = [[detail.material, detail.plant]]; field = 'PlannedDeliveryDurationInDays'; break;
        case 'requisition_review':
          kind = 'PurchaseRequisitionItem'; subjects = [[detail.PurchaseRequisition, detail.PurchaseRequisitionItem]]; field = 'reviewed_order'; break;
        case 'supplier_planned_time': {
          const evidence = JSON.parse(detail.detail ?? '{}');
          const materialMaster = evidence.currentFrom === 'material master';
          kind = materialMaster ? 'MaterialPlant' : 'PurchasingInfoRecordPlant';
          subjects = [[materialMaster ? detail.Material : detail.purchasingInfoRecord ?? evidence.PurchasingInfoRecord, detail.Plant]];
          field = materialMaster ? 'PlannedDeliveryDurationInDays' : 'MaterialPlannedDeliveryDurn';
          break;
        }
        default: throw new Error(`Unsupported active Case kind: ${header.kind}`);
      }
      assert.ok(subjects.length && subjects.every(subject => subject.every(value => typeof value === 'string' && value.trim())), `Incomplete source identity for ${header.ID}`);
      for (const subject of subjects) {
        const identity = { tenant: '', sourceSystem: 'tide.s4', kind, subjectKey: JSON.stringify(subject) };
        if (header.status === 'open') propose({ ...identity, claimType: 'case', slot: header.kind }, header, null);
        for (const action of activeActions) {
          assert.ok(action.operationKey, `Missing operation identity for ${action.ID}`);
          propose({ ...identity, claimType: 'action', slot: `${field}:${action.operationKey}` }, header, action);
        }
      }
    }
    const result = { plannedClaims: claims.size, insertedClaims: 0, retainedClaims: 0, preservedTables: preserved.length };
    const receiptID = randomUUID();
    for (const claim of claims.values()) {
      const identity = ['tenant', 'sourceSystem', 'kind', 'subjectKey', 'claimType', 'slot'];
      const existing = database.prepare(`SELECT * FROM ${quote(claimTable)} WHERE ${identity.map(key => `${quote(key)} = ?`).join(' AND ')}`).get(...identity.map(key => claim[key]));
      if (existing) {
        assert.equal(existing.caseID, claim.caseID, 'Existing claim has another Case owner');
        assert.equal(existing.actionID ?? null, claim.actionID, 'Existing claim has another Action owner');
        result.retainedClaims++;
      } else {
        if (mode === '--apply') {
          const values = { ...claim, commandID: receiptID };
          const keys = Object.keys(values);
          database.prepare(`INSERT INTO ${quote(claimTable)} (${keys.map(quote).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values));
        }
        result.insertedClaims++;
      }
    }
    if (mode === '--apply') {
      const occurredAt = new Date().toISOString();
      database.prepare(`INSERT INTO ${quote(commandTable)} (ID, tenant, principal, app, commandID, commandType, argsHash, subjects, result, committedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receiptID, '', 'local-schema-migration', 'tide.cockpit', version, 'backfillHistoricalClaims', hash({ version, baseline }), JSON.stringify(headers.map(header => ({ kind: 'case', ID: header.ID }))), JSON.stringify(result), occurredAt);
      database.exec(`CREATE TABLE IF NOT EXISTS ${quote(ledger)} (version TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, baseline TEXT NOT NULL, result TEXT NOT NULL, committedAt TEXT NOT NULL)`);
      database.prepare(`INSERT INTO ${quote(ledger)} VALUES (?, ?, ?, ?, ?)`).run(version, 'committed', JSON.stringify(baseline), JSON.stringify(result), occurredAt);
      for (const [name, before] of Object.entries(baseline)) assert.equal(fingerprint(name), before, `Historical rows changed: ${name}`);
      assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      database.exec('COMMIT');
    }
    console.log(JSON.stringify({ target, version, state: mode === '--apply' ? 'committed' : 'planned', result }, null, 2));
  }
} catch (error) {
  if (mode === '--apply' && database.isTransaction) database.exec('ROLLBACK');
  throw error;
} finally {
  database.close();
}