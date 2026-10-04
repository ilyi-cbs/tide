// CAP services expose stable, user-safe errors; raw upstream details stay in correlated logs.
import cds from "@sap/cds";

export const ERROR_MESSAGES = {
  TABULAR_UNAVAILABLE: "The prediction service is temporarily unavailable.",
  TABULAR_TIMEOUT: "The prediction service did not respond in time.",
  TABULAR_REJECTED: "The prediction service rejected the request.",
  TABULAR_MALFORMED: "The prediction service returned an invalid response.",
  TABULAR_OUTCOME_UNKNOWN:
    "The prediction outcome is unknown. It may still be running; automatic retry is disabled.",
  NO_TRAINING_DATA: "There are no training rows for this prediction.",
  UNKNOWN_KEYS: "Some rows to predict no longer exist.",
  INFERENCE_FAILED: "The inference service could not complete the request.",
  MODEL_TIMEOUT: "The prediction did not finish in time.",
  INTERNAL: "An internal error occurred.",
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/** An error whose code/message are safe to show; `detail` is log-only. */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public detail: string,
    public retryable = false,
    public status = 502,
  ) {
    super(ERROR_MESSAGES[code]);
  }
}

export function safeError(error: unknown): {
  errorCode: ErrorCode;
  errorMessage: string;
} {
  const errorCode = error instanceof AppError ? error.code : "INTERNAL";
  return { errorCode, errorMessage: ERROR_MESSAGES[errorCode] };
}

const LOG = cds.log("errors");

/**
 * HTTP status of an error; req.reject(400, ...) may carry it only as `code`.
 * Database errors (they have `sqlState`) use `code` for vendor error numbers,
 * which can fall into 400–599, so it is ignored for them (as CAP does).
 */
export function statusOf(err: any): number {
  const codeIsStatus = err.sqlState === undefined;
  for (const candidate of [
    err.status,
    err.statusCode,
    codeIsStatus ? err.code : undefined,
  ]) {
    const n = Number(candidate);
    if (Number.isInteger(n) && n >= 400 && n < 600) return n;
  }
  return 500;
}

/**
 * Replaces the message of every 5xx (or status-less, i.e. unexpected) error
 * with a generic one plus a reference ID, in all environments. CAP only does
 * this for OData in production; the MCP adapter never does.
 */
export function sanitizeErrors(srv: cds.Service) {
  srv.on("error", (err: any, req: any) => {
    const status = statusOf(err);
    if (status < 500) return;
    const reference = String(req?.id ?? cds.context?.id ?? cds.utils.uuid());
    LOG.error(`${srv.name} ${req?.event ?? ""} failed [${reference}]:`, err);
    const code: ErrorCode = err instanceof AppError ? err.code : "INTERNAL";
    err.message = `${ERROR_MESSAGES[code]} Reference: ${reference}`;
    err.code = code;
    delete err.details;
  });
}
