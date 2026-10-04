import type { PriceRow } from "./price";
import { PREDICTION_PROFILES } from "../../kernel/prediction-profiles";

export const PRICE_MODEL_CONTRACT = PREDICTION_PROFILES.price.version;
export const PRICE_LEVELS = [0.1, 0.5, 0.9];

export function unitPrice(row: PriceRow): number | null {
  const amount = Number(row.NetPriceAmount);
  const quantity = Number(row.NetPriceQuantity);
  const price = amount / quantity;
  return Number.isFinite(price) && amount > 0 && quantity > 0 && price > 0
    ? price
    : null;
}

export function priceQuantiles(values: number[]): number[] | null {
  if (values.length !== PRICE_LEVELS.length) return null;
  const prices = values.map(Math.exp);
  return prices.every(
    (price, index) =>
      Number.isFinite(price) &&
      price > 0 &&
      (index === 0 || price >= prices[index - 1]),
  )
    ? prices
    : null;
}

export function tailPosition(
  actual: number,
  p10: number | null,
  p50: number | null,
  p90: number | null,
) {
  if (
    p10 === null ||
    p50 === null ||
    p90 === null ||
    ![actual, p10, p50, p90].every(
      (price) => Number.isFinite(price) && price > 0,
    ) ||
    p10 > p50 ||
    p50 > p90
  )
    return null;
  if (actual === p50) return 0.5;
  const lowerWidth = Math.max(Math.log(p50 / p10), Number.EPSILON);
  const upperWidth = Math.max(Math.log(p90 / p50), Number.EPSILON);
  if (actual < p10) return 0.1 * Math.exp(Math.log(actual / p10) / lowerWidth);
  if (actual > p90)
    return 1 - 0.1 * Math.exp(Math.log(p90 / actual) / upperWidth);
  if (actual < p50) return 0.1 + (0.4 * Math.log(actual / p10)) / lowerWidth;
  return 0.5 + (0.4 * Math.log(actual / p50)) / upperWidth;
}

export const isPriceAlert = (tail: number | null, threshold = 0.05) =>
  tail !== null &&
  Number.isFinite(tail) &&
  threshold > 0 &&
  threshold <= 0.5 &&
  (tail <= threshold || tail >= 1 - threshold);

export function meanAbsoluteError(actual: number[], predicted: number[]) {
  if (!actual.length || actual.length !== predicted.length) return null;
  return (
    actual.reduce(
      (sum, value, index) => sum + Math.abs(value - predicted[index]),
      0,
    ) / actual.length
  );
}

export function intervalCoverage(
  actual: number[],
  lower: number[],
  upper: number[],
) {
  if (
    !actual.length ||
    actual.length !== lower.length ||
    actual.length !== upper.length
  )
    return null;
  return (
    actual.filter(
      (value, index) => value >= lower[index] && value <= upper[index],
    ).length / actual.length
  );
}

/** The calibration rule is deterministic and must be selected before holdout evaluation. */
export function selectTailThreshold(
  tails: number[],
  ordinary: boolean[],
  candidates = [0.01, 0.025, 0.05, 0.1],
) {
  if (tails.length !== ordinary.length || !tails.every(Number.isFinite))
    return null;
  for (const threshold of [...candidates].sort((left, right) => right - left)) {
    const alerts = tails.map((tail) => isPriceAlert(tail, threshold));
    const ordinaryAlerts = alerts.filter(
      (alert, index) => alert && ordinary[index],
    ).length;
    const ordinaryCount = ordinary.filter(Boolean).length;
    if (ordinaryCount && ordinaryAlerts / ordinaryCount <= 0.05)
      return threshold;
  }
  return null;
}
