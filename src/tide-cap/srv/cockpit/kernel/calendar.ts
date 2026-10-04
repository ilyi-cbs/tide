// Working days are Monday-Friday with no holidays; ISO dates use UTC midnight.
const DAY_MS = 86_400_000;

const toMs = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  return toIso(toMs(iso) + Math.ceil(days) * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** Buyer date in texts: "2025-12-06" -> "6 Dec 2025". */
export function dayText(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function isWorkingDay(iso: string): boolean {
  const d = new Date(toMs(iso)).getUTCDay();
  return d !== 0 && d !== 6;
}

/**
 * Working days in [from, to): `from` counted, `to` not (numpy busday_count).
 * Negative when to < from.
 */
export function workingDaysBetween(from: string, to: string): number {
  if (to < from) return -workingDaysBetween(to, from);
  let n = 0;
  for (let ms = toMs(from), end = toMs(to); ms < end; ms += DAY_MS)
    if (isWorkingDay(toIso(ms))) n++;
  return n;
}

/**
 * `n` working days after `iso` (numpy busday_offset, roll forward): a
 * weekend start first rolls to Monday; n = 0 returns that day.
 */
export function addWorkingDays(iso: string, n: number): string {
  let ms = toMs(iso);
  while (!isWorkingDay(toIso(ms))) ms += DAY_MS;
  const step = n < 0 ? -DAY_MS : DAY_MS;
  for (let left = Math.abs(n); left > 0;) {
    ms += step;
    if (isWorkingDay(toIso(ms))) left--;
  }
  return toIso(ms);
}
