// Shared low-level helpers of the prepareDay pipeline (prepare/*).
import cds from "@sap/cds";
import type { Row } from "../kernel/model-calls";

const { INSERT } = cds.ql;
const CHUNK = 500;

export const key = (m: string, s: string, p: string) => `${m}|${s}|${p}`;

export function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function insertAll(entity: string, rows: Row[]) {
  for (const batch of chunks(rows)) await INSERT.into(entity).entries(batch);
}

export interface SourceKey {
  Material: string;
  Supplier: string;
  Plant: string;
}
