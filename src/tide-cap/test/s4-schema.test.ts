import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import cds from "@sap/cds";

test("source loader mappings match the deployed source model", async () => {
  const model = await cds.load([
    path.join(__dirname, "../db/s4.cds"),
    path.join(__dirname, "../db/source.cds"),
  ]);
  const fixture = readFileSync(
    path.join(__dirname, "../../tide-loader/tests/schema.sql"),
    "utf8",
  );
  const expected = [
    ...(cds.compile.to.sql(model, { dialect: "sqlite" } as any) as any),
  ].join("\n");
  const normalize = (sql: string) =>
    sql.replace(/;/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(
    normalize(fixture),
    normalize(expected),
    "Shared source schema fixture is current",
  );
  const mappings: { entity: string; keys: string[]; columns: string[] }[] =
    JSON.parse(
      execFileSync(
        "uv",
        [
          "run",
          "--project",
          path.join(__dirname, "../../tide-loader"),
          "--frozen",
          "python",
          "-I",
          "-c",
          "import json; from loader.load import TABLES; assert all(table.namespace == 's4' for table in TABLES); print(json.dumps([{'entity': table.qualified, 'keys': table.keys, 'columns': [column.name for column in table.columns]} for table in TABLES]))",
        ],
        { encoding: "utf8" },
      ),
    );
  assert.ok(mappings.length > 0);
  for (const mapping of mappings) {
    const entity = model.definitions?.[mapping.entity];
    assert.ok(entity, mapping.entity);
    const elements = entity.elements ?? {};
    assert.deepEqual(
      mapping.keys.toSorted(),
      Object.entries(elements)
        .filter(([, element]) => element.key)
        .map(([name]) => name)
        .toSorted(),
      `${mapping.entity} keys`,
    );
    for (const column of mapping.columns)
      assert.ok(elements[column], `${mapping.entity}.${column}`);
  }
  for (const name of ["SourceLoads", "SourcePublications", "IngestOperations"])
    assert.ok(model.definitions?.[`tide.source.${name}`], name);
});

test("db/demo.cds is part of the deployed model", async () => {
  const model = await cds.load("*", {
    root: path.join(__dirname, ".."),
  } as any);
  for (const name of ["tide.truth.LeadTime", "tide.s4.ProductionOrder"])
    assert.ok(model.definitions?.[name], name);
});
