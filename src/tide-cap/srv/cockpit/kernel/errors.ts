// A CAP error with an HTTP status (safe message; < 500 so it reaches the
// client/MCP tool caller unchanged) — shared across features instead of
// each hand-rolling the same `new (cds.error as any)({status, message})`.
import cds from "@sap/cds";

export function fail(status: number, message: string, extra: object = {}): Error {
  const code =
    status === 409 ? "CONFLICT"
      : status === 404 ? "NOT_FOUND"
        : status === 403 ? "FORBIDDEN"
          : status >= 500 ? "INTERNAL"
            : "VALIDATION_ERROR";
  return new (cds.error as any)({
    status,
    code,
    message,
    retryable: false,
    retryAfterMs: null,
    ...extra,
  });
}
