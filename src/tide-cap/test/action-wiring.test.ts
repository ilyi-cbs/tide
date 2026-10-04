import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import cds from "@sap/cds";

const root = "app/purchasing-desk/webapp";
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

function visit(node: ts.Node, check: (node: ts.Node) => void) {
  check(node);
  ts.forEachChild(node, (child) => visit(child, check));
}

function source(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}

function walk(value: unknown, check: (key: string, value: string) => void) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") check(key, child);
    else walk(child, check);
  }
}

test("manifest action handlers and controller extensions resolve to declared methods", () => {
  let handlers = 0;
  walk(manifest, (key, value) => {
    if (key !== "press" || !value.includes("tide.cockpit.ext.")) return;
    const reference = value.replace(/^\.extension\./, "");
    const separator = reference.lastIndexOf(".");
    const module = reference.slice(0, separator);
    const method = reference.slice(separator + 1);
    const base = join(
      root,
      module.replace(/^tide\.cockpit\./, "").replaceAll(".", "/"),
    );
    const path = existsSync(base + ".js")
      ? base + ".js"
      : base + ".controller.js";
    assert.ok(existsSync(path), value + " module is missing");
    let declared = false;
    visit(source(path), (node) => {
      if (
        (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
        node.name?.getText().replace(/["']/g, "") === method
      )
        declared = true;
    });
    assert.ok(declared, value + " method is missing");
    handlers += 1;
  });
  assert.ok(handlers > 0);
  walk(manifest, (key, value) => {
    if (key !== "controllerName") return;
    const path = join(
      root,
      value.replace(/^tide\.cockpit\./, "").replaceAll(".", "/") +
        ".controller.js",
    );
    assert.ok(existsSync(path), value + " controller is missing");
  });
});

test("cockpit manifest and source references resolve to local UI resources", () => {
  function resource(reference: string) {
    const base = join(
      root,
      reference.replace(/^tide[./]cockpit[./]/, "").replaceAll(".", "/"),
    );
    assert.ok(
      [".js", ".controller.js", ".view.xml", ".fragment.xml"].some((suffix) =>
        existsSync(base + suffix),
      ),
      reference + " resource is missing",
    );
  }
  walk(manifest, (key, value) => {
    if (
      [
        "template",
        "viewName",
        "controllerName",
        "fragmentName",
        "expandedHeaderFragment",
        "collapsedHeaderFragment",
      ].includes(key) &&
      value.startsWith("tide.cockpit.")
    )
      resource(value);
  });
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (file.endsWith(".js"))
        visit(source(file), (node) => {
          if (ts.isStringLiteral(node) && node.text.startsWith("tide/cockpit/"))
            resource(node.text);
        });
      else if (file.endsWith(".xml")) {
        const xml = readFileSync(file, "utf8");
        for (const match of xml.matchAll(
          /fragmentName="(tide\.cockpit\.[^"]+)"|['"](tide\/cockpit\/[^'"]+)['"]/g,
        ))
          resource(match[1] ?? match[2]!);
        for (const namespace of xml.matchAll(
          /xmlns:([\w]+)="(tide\.cockpit\.[^"]+)"/g,
        ))
          for (const tag of xml.matchAll(
            new RegExp("<" + namespace[1] + ":([\\w]+)", "g"),
          ))
            resource(namespace[2] + "." + tag[1]);
      }
    }
  }
  scan(join(root, "ext"));
});

test("literal cockpit navigation targets resolve to registered routes", () => {
  const routes = new Set(
    manifest["sap.ui5"].routing.routes.map(
      (route: { name: string }) => route.name,
    ),
  );
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith(".js"))
        visit(source(path), (node) => {
          if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            node.expression.name.text !== "navigateToRoute"
          )
            return;
          const target = node.arguments[0];
          if (target && ts.isStringLiteral(target))
            assert.ok(
              routes.has(target.text),
              path + ": unknown route " + target.text,
            );
        });
    }
  }
  scan(join(root, "ext"));
});

test("literal UI OData operations exist in the service model", async () => {
  const model = await cds.load(["srv", "srv/cockpit"]);
  const servicePaths = new Set(
    Object.values(manifest["sap.app"].dataSources).map((dataSource: any) =>
      String(dataSource.uri ?? "")
        .replace(/\/$/, "")
        .split("/")
        .at(-1),
    ),
  );
  const services = Object.entries(model.definitions ?? {})
    .filter(
      ([, definition]) =>
        definition.kind === "service" &&
        "@path" in definition &&
        servicePaths.has(
          String(definition["@path"] ?? "")
            .replace(/\/$/, "")
            .split("/")
            .at(-1),
        ),
    )
    .map(([name]) => name);
  assert.ok(services.includes("PurchasingDeskService"));
  assert.ok(services.includes("WorkflowService"));
  const operations = new Set<string>();
  for (const [name, definition] of Object.entries(model.definitions ?? {})) {
    const service = services.find(
      (candidate) => name === candidate || name.startsWith(`${candidate}.`),
    );
    if (!service) continue;
    if (definition.kind === "action" || definition.kind === "function")
      operations.add(name.slice(service.length + 1));
    const actions =
      "actions" in definition
        ? (definition.actions as Record<string, unknown>)
        : {};
    for (const action of Object.keys(actions || {})) operations.add(action);
  }
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith(".js"))
        visit(source(path), (node) => {
          if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression)
          )
            return;
          const method = node.expression.name.text;
          const argument = node.arguments[0];
          if (
            !["invokeAction", "bindContext"].includes(method) ||
            !argument ||
            !ts.isStringLiteral(argument)
          )
            return;
          if (method === "bindContext" && !argument.text.endsWith("(...)"))
            return;
          const name = argument.text
            .replace(/^\/?(?:PurchasingDeskService\.|WorkflowService\.)?/, "")
            .replace(/\(\.\.\.\)$/, "");
          assert.ok(
            operations.has(name),
            path + ": unknown OData operation " + argument.text,
          );
        });
    }
  }
  scan(join(root, "ext"));
});
