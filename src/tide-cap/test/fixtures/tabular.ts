import cds from "@sap/cds";
import { createServer } from "node:http";
import { after, before } from "node:test";

/** Explicit offline backend for suites that indirectly invoke day preparation. */
export function useFakeTabular() {
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ status: "ok", backend: "fake" }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    const classes = request.task === "classification" ? [...new Set(request.y_train.map(String))] : null;
    res.end(JSON.stringify({
      task: request.task, output_type: request.output.type, classes,
      levels: request.output.levels ?? null,
      predictions: request.keys.map((row_key: string) => ({
        row_key, value: classes?.[0] ?? 14,
        probabilities: classes?.map(() => 1 / classes.length) ?? null,
        quantiles: request.output.levels?.map((level: number) => 7 + level * 14) ?? null,
      })),
      fallback: null, dropped_columns: [], train_rows: request.x_train.length, elapsed_ms: 1,
      usage: { backend: "fake", calls: 1, cost_units: 0 },
    }));
  });
  let previous: unknown;
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    previous = (cds.env.requires as any).tabular;
    (cds.env.requires as any).tabular = {
      ...(previous as object), credentials: { url: `http://127.0.0.1:${(server.address() as any).port}` },
    };
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (cds.env.requires as any).tabular = previous;
  });
}
