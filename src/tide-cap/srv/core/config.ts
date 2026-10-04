import cds from "@sap/cds";

export function dataVersion(): string {
  return process.env.DATA_VERSION || "1";
}

export function maxContextRows(): number {
  return Number(process.env.TIDE_MAX_CONTEXT_ROWS || 10_000);
}

/** Agent URL precedence: CDS config, then AGENT_URL, then localhost. */
export function agentUrl(): string {
  return (
    (cds.env as any).tide?.agent?.url ??
    process.env.AGENT_URL ??
    "http://127.0.0.1:8081"
  );
}

/** Returns budget inputs; TIDE_BUDGET overrides the CDS setting in budgetLimit. */
export function budgetLimitInputs(): {
  env: string | undefined;
  configured: unknown;
} {
  return {
    env: process.env.TIDE_BUDGET,
    configured: (cds.env as any).cockpit?.budget?.costUnits,
  };
}

/** CLI target from TIDE_URL and TIDE_AUTH; unset values use local defaults. */
export function cockpitCliTarget(): { url: string; auth: string } {
  const url =
    process.env.TIDE_URL ?? `http://localhost:${process.env.CAP_PORT ?? 4004}`;
  const auth = process.env.TIDE_AUTH ?? "";
  return { url, auth };
}

/** Maximum wait for a prediction-question run. */
export function predictWaitMs(): number {
  return Number(process.env.TIDE_PREDICT_WAIT_MS ?? 20_000);
}

/** Optional database path for CAP CLI scripts, configured by TIDE_DB. */
export function cockpitDbFile(): string | undefined {
  return process.env.TIDE_DB;
}

/** Timeout for a single tabular request. */
export function tabularTimeoutMs(defaultMs: number): number {
  return Number(process.env.TABULAR_TIMEOUT_MS) || defaultMs;
}

export function tabularExecutionLeaseMs(): number {
  const minimum = tabularTimeoutMs(180_000) + 30_000;
  const configured =
    process.env.TABULAR_EXECUTION_LEASE_MS ??
    (cds.env.requires as any).tabular?.executionLeaseMs ??
    minimum;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`TABULAR_EXECUTION_LEASE_MS must be at least ${minimum}`);
  return value;
}

export function genericInferenceConfig(
  defaultPath: string,
  defaultTimeoutMs: number,
): {
  baseUrl: string | undefined;
  path: string;
  timeoutMs: number;
  token: string | undefined;
} {
  return {
    baseUrl: process.env.TIDE_AI_URL,
    path: process.env.TIDE_AI_GENERIC_PATH || defaultPath,
    timeoutMs: Number(
      process.env.TIDE_AI_GENERIC_TIMEOUT_MS || String(defaultTimeoutMs),
    ),
    token: process.env.TIDE_AI_TOKEN,
  };
}
