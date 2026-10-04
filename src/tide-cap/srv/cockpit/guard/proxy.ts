// Same-origin chat proxy (guard): /agent, /agent/*, /threads/* are forwarded
// to the agent service, SSE streamed back unbuffered. Only for callers with
// an Authorization header (the agent re-checks it against CAP MCP).
import cds from "@sap/cds";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { agentUrl as configuredAgentUrl } from "../../core/config";

const LOG = cds.log("guard");

const FORWARD = [
  "authorization",
  "x-tide-app-id",
  "x-correlation-id",
  "content-type",
  "accept",
  "last-event-id",
];

export function agentUrl(): string {
  return configuredAgentUrl().replace(/\/+$/, "");
}

/** Upstream path of a proxied request: /agent -> /agent, /agent/x -> /x, /threads/x -> /threads/x. */
export function upstreamPath(url: string): string {
  if (url === "/agent" || url.startsWith("/agent?")) return url;
  if (url.startsWith("/agent/")) return url.slice("/agent".length);
  return url;
}

function send(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: { code, message } }));
}

export async function proxy(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  if (!req.headers.authorization) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Users"');
    return send(res, 401, "UNAUTHORIZED", "Sign in to use the assistant");
  }
  const method = (req.method ?? "GET").toUpperCase();
  const path = upstreamPath(req.url ?? "/");

  const headers: Record<string, string> = {};
  for (const h of FORWARD) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
    signal: abort.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    // Mounted before any body parser, so the stream is normally untouched.
    if (req.body !== undefined && req.readableEnded)
      init.body =
        typeof req.body === "string" || Buffer.isBuffer(req.body)
          ? (req.body as any)
          : JSON.stringify(req.body);
    else {
      init.body = Readable.toWeb(req) as any;
      init.duplex = "half";
    }
  }

  let up: Response;
  try {
    up = await fetch(`${agentUrl()}${path}`, init);
  } catch (e: unknown) {
    if (abort.signal.aborted) return;
    LOG.warn("agent unreachable", e instanceof Error ? e.message : e);
    return send(
      res,
      502,
      "AGENT_UNREACHABLE",
      "The assistant service is not reachable",
    );
  }
  res.statusCode = up.status;
  up.headers.forEach((v, k) => {
    if (
      ![
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "connection",
      ].includes(k)
    )
      res.setHeader(k, v);
  });
  if ((up.headers.get("content-type") ?? "").includes("text/event-stream")) {
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-accel-buffering", "no");
  }
  res.flushHeaders();
  if (!up.body) return res.end();
  const body = Readable.fromWeb(up.body as any);
  body.on("error", () => res.destroy());
  body.pipe(res);
}

let mounted = false;

/**
 * Mounts at CAP's `served` event, ahead of body parsers and fallback routes.
 */
export function mountProxy(app: any) {
  if (mounted || !app?.use) return;
  mounted = true;
  const h = (req: any, res: any, next: any) => {
    req.url = req.originalUrl;
    proxy(req, res).catch(next);
  };
  const stack: any[] | undefined = (app.router ?? app._router)?.stack;
  const before = stack?.length ?? 0;
  app.use("/agent", h);
  app.use("/threads", h);
  if (stack && stack.length === before + 2)
    stack.unshift(...stack.splice(before, 2));
}
