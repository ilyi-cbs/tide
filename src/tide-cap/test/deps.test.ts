// Dependency rule of the cockpit v3 (contract A1): a feature folder imports
// only its own files, ../kernel/*, ../../core/*, @sap/cds and node
// built-ins; never another feature folder, prepare.ts or cockpit-service.ts.
import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.join(__dirname, "../srv/cockpit");
const FEATURES = [
  "atrisk",
  "impact",
  "rules",
  "leadtimes",
  "planning",
  "freetext",
  "feed",
  "overview",
  "guard",
];
const BUILTINS = new Set(builtinModules);
// Pure in-memory libraries without service or framework coupling.
const LIBRARIES = new Set(["fuse.js"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.(ts|js|mjs|cjs)$/.test(f)
        ? [p]
        : [];
  });
}

/** Module specifiers of import / export-from / require / dynamic import statements. */
export function specifiers(source: string): string[] {
  const out: string[] = [];
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  for (const re of [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ])
    for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/** Why `spec`, imported by `file` of feature `feature`, breaks the rule (null if allowed). */
export function violation(
  feature: string,
  file: string,
  spec: string,
): string | null {
  if (spec.startsWith("node:") || BUILTINS.has(spec)) return null;
  if (spec === "@sap/cds" || spec.startsWith("@sap/cds/")) return null;
  if (LIBRARIES.has(spec)) return null;
  if (!spec.startsWith(".")) return `package ${spec}`;
  const target = path.resolve(path.dirname(file), spec);
  const rel = path.relative(ROOT, target).split(path.sep);
  if (rel[0] === feature) return null; // own folder
  if (rel[0] === "kernel") return null;
  const lib = path.relative(path.join(ROOT, "../core"), target);
  if (!lib.startsWith("..") && !path.isAbsolute(lib)) return null;
  if (FEATURES.includes(rel[0])) return `other feature ${rel[0]}`;
  return `${path.relative(ROOT, target) || spec}`;
}

test("the dependency checker recognises allowed and forbidden imports", () => {
  const f = path.join(ROOT, "impact/index.ts");
  assert.equal(violation("impact", f, "../kernel/findings"), null);
  assert.equal(violation("impact", f, "../../core/errors"), null);
  assert.equal(violation("impact", f, "./logic"), null);
  assert.equal(violation("impact", f, "@sap/cds"), null);
  assert.equal(violation("impact", f, "node:fs"), null);
  assert.match(
    violation("impact", f, "../atrisk") ?? "",
    /other feature atrisk/,
  );
  assert.match(violation("impact", f, "../prepare") ?? "", /prepare/);
  assert.match(violation("impact", f, "../cockpit") ?? "", /cockpit/);
  assert.match(violation("impact", f, "express") ?? "", /package/);
  assert.deepEqual(
    specifiers(
      `import a from "./a";\nimport type { B } from '../kernel/types';\nexport * from "./c";\nconst d = await import("../atrisk");\n// import x from "../rules"`,
    ),
    ["./a", "../kernel/types", "./c", "../atrisk"],
  );
});

test("feature folders import only their own files, ../kernel, ../../core, @sap/cds and node built-ins", () => {
  const problems: string[] = [];
  for (const feature of FEATURES) {
    const dir = path.join(ROOT, feature);
    assert.ok(statSync(dir).isDirectory(), `feature folder ${feature} exists`);
    for (const file of files(dir))
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        const why = violation(feature, file, spec);
        if (why)
          problems.push(`${path.relative(ROOT, file)}: "${spec}" (${why})`);
      }
  }
  assert.deepEqual(
    problems,
    [],
    "forbidden imports:\n  " + problems.join("\n  "),
  );
});
