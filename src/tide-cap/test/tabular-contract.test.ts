// The shared examples in tabular/tests/fixtures/examples are written by tabular's own
// tests from real service answers; CAP's client must accept each of them for
// its request, so the two sides cannot drift apart unnoticed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import cds from "@sap/cds";
import { postTabular } from "../srv/core/tabular-client";

const EXAMPLES = path.join(__dirname, "../../tide-tabular/tests/fixtures/examples");
const names = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith(".request.json"))
  .map((f) => f.replace(".request.json", ""));
const read = (name: string, kind: string) =>
  JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.${kind}.json`), "utf8"));

let server: Server;
let reply: unknown;
let replyStatus = 200;
let disconnect = false;

beforeEach(() => {
  replyStatus = 200;
  disconnect = false;
});

before(async () => {
  server = createServer((_req, res) => {
    if (disconnect) {
      res.destroy();
      return;
    }
    res.writeHead(replyStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as any;
  (cds.env.requires as any).tabular = {
    credentials: { url: `http://127.0.0.1:${port}` },
  };
});

after(() => new Promise<void>((r) => server.close(() => r())));

describe("tabular contract examples", () => {
  test("every output type has an example", () => {
    for (const name of ["probas", "point", "quantiles", "fallback", "dry_run"])
      assert.ok(names.includes(name), `missing example ${name}`);
  });

  for (const name of names)
    test(`CAP accepts tabular's answer: ${name}`, async () => {
      const request = { mode: "predict", ...read(name, "request") };
      reply = read(name, "response");
      const result = await postTabular(request);
      assert.equal(result.predictions.length, request.keys.length);
      assert.equal(result.output_type, request.output.type);
      assert.ok(Number.isFinite(result.usage?.cost_units));
    });

  for (const mode of ["predict", "dry_run"] as const)
    test(`accepts a regression point fallback in ${mode} mode`, async () => {
      const request = { mode, ...read("point", "request") };
      const body = read("point", "response");
      body.fallback = "context_distribution";
      body.placeholder = false;
      body.dropped_columns = request.columns.map((column: any) => column.name);
      Object.assign(body.usage, {
        calls: 0,
        context_cells: 0,
        predicted_cells: 0,
        cost_units: 0,
        effective_feature_count: 0,
        num_cells: null,
        num_predictions: null,
      });
      reply = body;
      assert.equal(
        (await postTabular(request)).fallback,
        "context_distribution",
      );
    });

  const malformed: [string, string, (body: any) => void][] = [
    [
      "unknown dropped column",
      "point",
      (body) => {
        body.dropped_columns = ["unknown"];
      },
    ],
    [
      "conflicting metadata",
      "point",
      (body) => {
        body.classes = ["unexpected"];
      },
    ],
    [
      "duplicate classes",
      "probas",
      (body) => {
        body.classes = ["late", "late"];
      },
    ],
    [
      "negative probability",
      "probas",
      (body) => {
        body.predictions[0].probabilities = [-1, 2];
      },
    ],
    [
      "unnormalized probabilities",
      "probas",
      (body) => {
        body.predictions[0].probabilities = [0.2, 0.2];
      },
    ],
    [
      "unknown class",
      "probas",
      (body) => {
        body.predictions[0].value = "unknown";
      },
    ],
    [
      "non-argmax class",
      "probas",
      (body) => {
        body.predictions[0].value = body.classes[0];
      },
    ],
    [
      "wrong task",
      "point",
      (body) => {
        body.task = "classification";
      },
    ],
    [
      "wrong levels",
      "quantiles",
      (body) => {
        body.levels = [0.2, 0.8];
      },
    ],
    [
      "crossed quantiles",
      "quantiles",
      (body) => {
        body.predictions[0].quantiles = [20, 10];
      },
    ],
    [
      "live placeholder",
      "point",
      (body) => {
        body.placeholder = true;
      },
    ],
    [
      "null value",
      "point",
      (body) => {
        body.predictions[0].value = null;
      },
    ],
    [
      "string value",
      "point",
      (body) => {
        body.predictions[0].value = "12";
      },
    ],
    [
      "boolean value",
      "point",
      (body) => {
        body.predictions[0].value = true;
      },
    ],
    [
      "coerced usage",
      "point",
      (body) => {
        body.usage.calls = "1";
      },
    ],
    [
      "fractional count",
      "point",
      (body) => {
        body.usage.calls = 1.5;
      },
    ],
  ];
  for (const [label, name, mutate] of malformed)
    test(`rejects ${label} without retry`, async () => {
      const body = read(name, "response");
      mutate(body);
      reply = body;
      await assert.rejects(
        postTabular({ mode: "predict", ...read(name, "request") }),
        (error: any) =>
          error.code === "TABULAR_MALFORMED" && error.retryable === false,
      );
    });

  test("accepts probability ties and numerical sum tolerance", async () => {
    const body = read("probas", "response");
    body.predictions.forEach((prediction: any) => {
      prediction.probabilities = [0.5, 0.5000005];
      prediction.value = body.classes[1];
    });
    reply = body;
    await postTabular({ mode: "predict", ...read("probas", "request") });
    body.predictions.forEach((prediction: any) => {
      prediction.probabilities = [0.5, 0.5];
    });
    await postTabular({ mode: "predict", ...read("probas", "request") });
  });

  test("inference transport loss is nonretryable and uncertain", async () => {
    disconnect = true;
    await assert.rejects(
      postTabular({ mode: "predict", ...read("point", "request") }),
      (error: any) =>
        error.code === "TABULAR_OUTCOME_UNKNOWN" && !error.retryable,
    );
  });

  for (const [status, code, expectedCode, retryable] of [
    [502, "UPSTREAM_MALFORMED", "TABULAR_MALFORMED", false],
    [504, "UPSTREAM_OUTCOME_UNKNOWN", "TABULAR_OUTCOME_UNKNOWN", false],
    [503, null, "TABULAR_OUTCOME_UNKNOWN", false],
    [429, "OVERLOADED", "TABULAR_UNAVAILABLE", true],
  ] as const)
    test(`maps ${code ?? "ambiguous server failure"} before generic status handling`, async () => {
      replyStatus = status;
      reply = code
        ? { error: { code, message: "test failure", retryable } }
        : null;
      await assert.rejects(
        postTabular({ mode: "predict", ...read("point", "request") }),
        (error: any) =>
          error.code === expectedCode && error.retryable === retryable,
      );
    });

  test("accepts equal quantiles but rejects inconsistent requested median", async () => {
    const request = { mode: "predict", ...read("quantiles", "request") };
    request.output.levels = [0.1, 0.5, 0.9];
    const body = read("quantiles", "response");
    body.levels = request.output.levels;
    body.predictions.forEach((prediction: any) => {
      prediction.quantiles = [10, 10, 10];
      prediction.value = 10;
    });
    reply = body;
    await postTabular(request);
    body.predictions[0].value = 11;
    await assert.rejects(
      postTabular(request),
      (error: any) => error.code === "TABULAR_MALFORMED",
    );
  });
});
