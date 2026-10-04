import cds from "@sap/cds";
import assert from "node:assert/strict";
import { test } from "node:test";

type ModelDefinition = {
  kind?: string;
  $location?: { file: string };
  query?: unknown;
  elements?: Record<string, { key?: boolean; target?: string }>;
  "@path"?: string;
  "@readonly"?: boolean;
};

test("assessment and publication persistence has one database owner", async () => {
  const model = await cds.load("*");
  const definitions = model.definitions as
    Record<string, ModelDefinition> | undefined;
  assert.ok(definitions);
  const owners = {
    "db/assessment.cds": [
      "ItemFact",
      "FindingStatus",
      "FindingType",
      "SourceRange",
      "OpenItem",
      "CustomerImpact",
      "SourceFinding",
      "SourceBacktest",
      "ProofResult",
      "PreventionAssessment",
      "AssessmentApplicability",
    ],
    "db/publication.cds": ["Snapshot", "CustomerRisk"],
  };
  for (const [owner, entities] of Object.entries(owners)) {
    for (const entity of entities) {
      const definition: ModelDefinition = definitions[`tide.cockpit.${entity}`];
      assert.ok(definition, entity);
      assert.equal(definition.$location?.file, owner, entity);
      assert.equal(definition.kind, "entity", entity);
    }
  }
  for (const name of ["ItemReceipt", "ItemSchedule", "ItemFactSource"]) {
    const definition: ModelDefinition = definitions[`tide.cockpit.${name}`];
    assert.equal(
      definition.$location?.file,
      "srv/cockpit/facts.cds",
      name,
    );
    assert.ok(
      definition.query,
      `${name} is a derived query, not another table`,
    );
  }
});

test("data models compile without depending on the service layer", async () => {
  const model = await cds.load(["db/assessment.cds", "db/publication.cds"]);
  const definitions = model.definitions as
    Record<string, ModelDefinition> | undefined;
  assert.ok(definitions);
  const serviceDependencies = Object.entries(definitions).filter(
    ([, definition]) => definition.$location?.file.startsWith("srv/"),
  );
  assert.deepEqual(serviceDependencies, []);
  const sql = cds.compile.to.sql(model);
  for (const name of ["Snapshot", "ItemFact", "SourceRange", "CustomerRisk", "PreventionAssessment", "AssessmentApplicability"]) {
    assert.equal(
      sql.filter((statement) =>
        statement.startsWith(`CREATE TABLE tide_cockpit_${name} (`),
      ).length,
      1,
      name,
    );
  }
});

test("source lineage persists privately alongside the legacy dataset marker", async () => {
  const model = await cds.load("db/source.cds");
  const definitions = model.definitions as Record<string, ModelDefinition>;
  const sql = cds.compile.to.sql(model);
  for (const name of ["SourceLoads", "SourcePublications", "IngestOperations"]) {
    const definition = definitions[`tide.source.${name}`];
    assert.equal(definition.$location?.file, "db/source.cds", name);
    assert.equal(definition.kind, "entity", name);
    assert.equal(
      sql.filter((statement) =>
        statement.startsWith(`CREATE TABLE tide_source_${name} (`),
      ).length,
      1,
      name,
    );
  }
  assert.equal(definitions["tide.source.SourceLoads"].elements?.ID.key, true);
  assert.equal(
    definitions["tide.source.SourcePublications"].elements?.name.key,
    true,
  );
  assert.equal(
    definitions["tide.source.SourcePublications"].elements?.load.target,
    "tide.source.SourceLoads",
  );
  assert.ok(
    !Object.values(definitions).some((definition) =>
      definition.$location?.file.startsWith("srv/"),
    ),
  );
  const fullModel = await cds.load("*");
  assert.ok(fullModel.definitions);
  assert.equal(fullModel.definitions["tide.s4.DatasetInfo"]?.kind, "entity");
});

test("publication target keeps scoped baselines and immutable brief inputs", async () => {
  const model = await cds.load("db/publication-target.cds");
  const definitions = model.definitions as Record<string, ModelDefinition>;
  const sql = cds.compile.to.sql(model);
  for (const name of ["PublicationBaselines", "Scenarios", "ScenarioAssumptions", "Briefs", "BriefFacts", "BriefNarratives"]) {
    const definition = definitions[`tide.publication.${name}`];
    assert.equal(definition.$location?.file, "db/publication-target.cds", name);
    assert.equal(definition.kind, "entity", name);
    assert.ok(sql.some((statement) => statement.startsWith(`CREATE TABLE tide_publication_${name} (`)), name);
  }
  assert.equal(definitions["tide.publication.PublicationBaselines"].elements?.snapshot.target, "tide.cockpit.Snapshot");
  assert.equal(definitions["tide.publication.BriefFacts"].elements?.brief.key, true);
  assert.equal(definitions["tide.publication.BriefNarratives"].elements?.brief.target, "tide.publication.Briefs");
  assert.equal(definitions["tide.publication.ScenarioAssumptions"].elements?.scenarioVersion.key, true);
});

test("assessment target owns typed facts, evidence, and independent questions", async () => {
  const model = await cds.load("db/assessment-target.cds");
  const definitions = model.definitions as Record<string, ModelDefinition>;
  const sql = cds.compile.to.sql(model);
  for (const name of ["Assessments", "AssessmentSubjects", "AssessmentEvidence", "DeliveryFacts", "DeliveryImpacts", "PlanningFacts", "PriceFacts", "DuplicateFacts", "DuplicateCandidates", "SettingFacts", "UnusualSettingPairs", "SupplierTimeFacts", "MaterialTimeFacts", "MaterialPlannedTimeSources", "ProposedChanges", "LocalConfirmations", "Questions", "QuestionDecisions"]) {
    const definition = definitions[`tide.assessment.${name}`];
    assert.equal(definition.$location?.file, "db/assessment-target.cds", name);
    assert.equal(definition.kind, "entity", name);
    assert.ok(sql.some((statement) => statement.startsWith(`CREATE TABLE tide_assessment_${name} (`)), name);
  }
  assert.equal(definitions["tide.assessment.DeliveryImpacts"].elements?.fact.target, "tide.assessment.DeliveryFacts");
  assert.equal(definitions["tide.assessment.DuplicateCandidates"].elements?.fact.key, true);
  assert.equal(definitions["tide.assessment.MaterialPlannedTimeSources"].elements?.fact.target, "tide.assessment.MaterialTimeFacts");
  assert.equal(definitions["tide.assessment.AssessmentEvidence"].elements?.run.target, "tide.core.PredictionRun");
  assert.equal(definitions["tide.assessment.QuestionDecisions"].elements?.question.target, "tide.assessment.Questions");
  assert.equal(definitions["tide.assessment.Questions"].elements?.assessment.key, undefined);
});

test("review target retains distinct working and submitted detail", async () => {
  const model = await cds.load("db/review-target.cds");
  const definitions = model.definitions as Record<string, ModelDefinition>;
  const sql = cds.compile.to.sql(model);
  for (const name of ["RequisitionReviews", "WorkingItems", "WorkingAllocations", "FieldEvidence", "FieldDecisions", "ReviewEvidence", "ReviewSubmissions", "SubmittedItems", "SubmittedAllocations", "ReviewEvents"]) {
    const definition = definitions[`tide.review.${name}`];
    assert.equal(definition.$location?.file, "db/review-target.cds", name);
    assert.equal(definition.kind, "entity", name);
    assert.ok(sql.some((statement) => statement.startsWith(`CREATE TABLE tide_review_${name} (`)), name);
  }
  assert.equal(definitions["tide.review.WorkingItems"].elements?.review.key, true);
  assert.equal(definitions["tide.review.SubmittedItems"].elements?.submission.target, "tide.review.ReviewSubmissions");
  assert.equal(definitions["tide.review.ReviewEvents"].elements?.command.target, "tide.workflow.WorkflowCommands");
  assert.equal(definitions["tide.review.FieldEvidence"].elements?.run.target, "tide.core.PredictionRun");
});

test("tabular reservations and workflow grants stay with existing owners", async () => {
  const model = await cds.load(["db/core.cds", "db/workflow.cds"]);
  const definitions = model.definitions as Record<string, ModelDefinition>;
  const sql = cds.compile.to.sql(model);
  for (const [name, owner] of [
    ["tide.core.UsageReservations", "db/core.cds"],
    ["tide.workflow.ScopeGrants", "db/workflow.cds"],
  ]) {
    assert.equal(definitions[name].$location?.file, owner, name);
    assert.ok(sql.some((statement) => statement.startsWith(`CREATE TABLE ${name.replaceAll(".", "_")} (`)), name);
  }
  assert.equal(definitions["tide.core.UsageReservations"].elements?.request.target, "tide.core.PredictionRequest");
  assert.equal(definitions["tide.core.UsageReservations"].elements?.run.target, "tide.core.PredictionRun");
  assert.equal(definitions["tide.core.PredictionRequest"].elements?.run.target, "tide.core.PredictionRun");
  assert.equal(definitions["tide.workflow.ScopeGrants"].elements?.ID.key, true);
});

test("workflow target case and action roots remain private migration records", async () => {
  const model = await cds.load("db/workflow-target.cds");
  const definitions = model.definitions as Record<string, ModelDefinition>;
  const sql = cds.compile.to.sql(model);
  for (const name of ["Cases", "CaseSubjects", "CaseEvents", "Actions", "ActionItems", "CaseActions", "ActionEvents"]) {
    const definition = definitions[`tide.workflowTarget.${name}`];
    assert.equal(definition.$location?.file, "db/workflow-target.cds", name);
    assert.equal(definition.kind, "entity", name);
    assert.ok(sql.some((statement) => statement.startsWith(`CREATE TABLE tide_workflowTarget_${name} (`)), name);
  }
  assert.equal(definitions["tide.workflowTarget.Cases"].elements?.ID.key, true);
  assert.equal(definitions["tide.workflowTarget.CaseSubjects"].elements?.header.target, "tide.workflowTarget.Cases");
  assert.equal(definitions["tide.workflowTarget.ActionItems"].elements?.action.key, true);
  assert.equal(definitions["tide.workflowTarget.CaseActions"].elements?.action.target, "tide.workflowTarget.Actions");
  assert.equal(definitions["tide.workflowTarget.ActionEvents"].elements?.command.target, "tide.workflow.WorkflowCommands");
  assert.ok(!Object.values(definitions).some((definition) => definition.$location?.file.startsWith("srv/")));
});

test("cockpit projections retain public keys and redirected relationships", async () => {
  const model = await cds.load("*");
  const definitions = model.definitions as
    Record<string, ModelDefinition> | undefined;
  assert.ok(definitions);
  assert.equal(definitions.PurchasingDeskService["@path"], "desk");
  assert.equal(definitions["PurchasingDeskService.Snapshots"].elements?.ID.key, true);
  const openItems = definitions["PurchasingDeskService.OpenItems"];
  assert.equal(openItems.elements?.PurchaseOrder.key, true);
  assert.equal(openItems.elements?.PurchaseOrderItem.key, true);
  assert.equal(
    openItems.elements?.sourceRange.target,
    "PurchasingDeskService.SourceRanges",
  );
  assert.equal(
    openItems.elements?.impacts.target,
    "PurchasingDeskService.CustomerImpacts",
  );
  assert.equal(definitions["PurchasingDeskService.SourceRanges"]["@readonly"], true);
  assert.equal(definitions["PurchasingDeskService.Customers"]["@readonly"], true);
});
