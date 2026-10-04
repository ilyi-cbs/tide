// Pure numeric helpers shared across features (contract A1): the median
// (and rounding) every feature otherwise hand-rolled with the same
// sort-and-average-the-middle algorithm.

/** Middle value of the sorted array (average of the two middles if even); NaN for an empty array. */
export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Rounds to `digits` decimal places (default 2). */
export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Area under the ROC curve (Mann-Whitney U via midranks, ties averaged). NaN if either class is empty. */
export function auc(y: number[], score: number[]): number {
  const idx = score.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(score.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = r;
    i = j + 1;
  }
  let pos = 0;
  let sum = 0;
  y.forEach((v, i) => {
    if (v === 1) {
      pos++;
      sum += ranks[i];
    }
  });
  const neg = y.length - pos;
  if (!pos || !neg) return NaN;
  return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
}

// ------------------------------------------------------------ cost units

/**
 * Cost model of the TabPFN deployment (cost units per cell). Mirrors
 * tabular/src/tabular/application/predict.py, which reports it as
 * usage.cost_units; core keeps only calls and rows of a run, so features
 * derive a run's cost from those with the same formula.
 */
export const CU_PER_CONTEXT_CELL = 1.05e-6;
export const CU_PER_PREDICTED_CELL = 1.45e-4;

/** Cost units of one executed (or planned) run (tabular's usage.cost_units). */
export function runCost(run: { calls: number; trainRows: number; testRows: number; columns: number }): number {
  const { calls, trainRows, testRows, columns } = run;
  if (!calls || !columns) return 0;
  const context = trainRows * (columns + 1) * calls;
  const predicted = testRows * columns;
  return Math.round((CU_PER_CONTEXT_CELL * context + CU_PER_PREDICTED_CELL * predicted) * 1e10) / 1e10;
}

