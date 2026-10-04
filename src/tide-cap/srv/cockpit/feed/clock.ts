// Simulated business clock of the feeder (P-10). Pure, no CDS imports.
//
// Business hours are Monday to Friday, 07:00 to 18:00; nights and weekends
// are skipped. Simulated time has no time zone: it is written as an ISO
// timestamp with "Z" and computed in UTC, so 08:00 means 08:00 on the plant
// calendar wherever the server runs.

export const DAY_START_H = 7;
export const DAY_END_H = 18;
/** Default pace: one business hour per real minute (60 simulated seconds per real second). */
export const PACE = 60;

export type EntryKind = "po_item" | "goods_receipt" | "confirmation" | "freetext";

/** Hours of the day in which each kind arrives: [from, to). */
export const SLOTS: Record<EntryKind, [number, number]> = {
  po_item: [8, 16],
  goods_receipt: [7, 15],
  confirmation: [10, 17],
  freetext: [9, 17],
};

/** Tie-break at the same moment: receipts first, then new items, confirmations, free text. */
export const KIND_ORDER: Record<string, number> = { change: -1, goods_receipt: 0, po_item: 1, confirmation: 2, freetext: 3 };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ms = (t: string | number | Date) => (typeof t === "number" ? t : new Date(t).getTime());
export const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");

function dayStart(t: number) {
  return Math.floor(t / DAY) * DAY;
}
const weekday = (t: number) => new Date(t).getUTCDay(); // 0 Sunday … 6 Saturday
const isWorkday = (t: number) => weekday(t) >= 1 && weekday(t) <= 5;
const hourOf = (t: number) => (t - dayStart(t)) / HOUR;

/** The same moment if it lies in business hours, else the start of the next business day. */
export function business(t: string | number | Date): string {
  const x = ms(t);
  if (isWorkday(x) && hourOf(x) >= DAY_START_H && hourOf(x) < DAY_END_H) return iso(x);
  let d = dayStart(x) + (hourOf(x) >= DAY_END_H ? DAY : 0);
  while (!isWorkday(d)) d += DAY;
  return iso(d + DAY_START_H * HOUR);
}

/** Moves the clock by `seconds` of business time; nights and weekends are skipped. */
export function advance(t: string | number | Date, seconds: number): string {
  let x = ms(business(t));
  let left = seconds * 1000;
  while (left > 0) {
    const end = dayStart(x) + DAY_END_H * HOUR;
    const step = Math.min(left, end - x);
    x += step;
    left -= step;
    if (left > 0 || x >= end) x = ms(business(x));
  }
  return iso(x);
}

/** Business seconds between two moments (b after a), for sleeping the feeder. */
export function businessSeconds(a: string, b: string): number {
  let x = ms(business(a));
  const target = ms(b);
  let s = 0;
  while (x < target) {
    const end = Math.min(dayStart(x) + DAY_END_H * HOUR, target);
    s += Math.max(0, end - x);
    if (end >= target) break;
    x = ms(business(dayStart(x) + DAY_END_H * HOUR));
  }
  return s / 1000;
}

/**
 * Times of `n` entries of one kind on one day, evenly over the kind's hours:
 * entry i at from + (i + 0.5) / n × (to − from). A weekend day moves to the
 * next Monday's slot (business()).
 */
export function spread(date: string, kind: EntryKind, n: number): string[] {
  const [lo, hi] = SLOTS[kind];
  const d0 = ms(`${date.slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    business(Math.round(d0 + lo * HOUR + ((i + 0.5) / n) * (hi - lo) * HOUR)),
  );
}

/** Start of the simulated day (07:00) of a calendar date. */
export function dayOpen(date: string): string {
  return business(`${date.slice(0, 10)}T0${DAY_START_H}:00:00Z`);
}

/** Demo cases: one per simulated business hour from `start`. */
export function hourly(start: string, n: number): string[] {
  return Array.from({ length: n }, (_, k) => advance(start, 3600 * k));
}
