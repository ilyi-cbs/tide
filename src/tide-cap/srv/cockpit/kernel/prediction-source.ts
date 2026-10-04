export type PredictionSource = "tabpfn" | "fake" | "fallback" | "none";

export function predictionSource(
  run:
    | {
        backend?: string | null;
        fallback?: string | null;
        placeholder?: boolean;
      }
    | null
    | undefined,
): PredictionSource {
  if (!run || run.placeholder) return "none";
  if (run.fallback) return "fallback";
  if (run.backend === "fake") return "fake";
  return ["priorlabs", "aicore"].includes(run.backend ?? "")
    ? "tabpfn"
    : "none";
}
