// As-of semantics (P-0) shared by the features.
import cds from "@sap/cds";

const { SELECT } = cds.ql;

/** As-of date of the loaded dataset (tide.s4.DatasetInfo), or null. */
export async function asOfDate(): Promise<string | null> {
  const info = await SELECT.one.from("tide.s4.DatasetInfo").columns("asOf").where({ ID: "current" });
  return info?.asOf ?? null;
}

/** P-0: a document dated `date` is known at `asOf` only when date < asOf. */
export const knownAt = (date: string | null | undefined, asOf: string) => !!date && date.slice(0, 10) < asOf;

export type SupplierRegion = "domestic" | "eu" | "overseas" | "unknown";

const REGIONS: Record<Exclude<SupplierRegion, "unknown">, string[]> = {
  domestic: ["DE", "AT"],
  eu: ["PL", "CZ", "IT", "NL", "FR", "HU"],
  overseas: ["CN", "US", "IN", "TW"],
};

/** P-0 supplier region from the supplier's country. */
export function supplierRegion(country: string | null | undefined): SupplierRegion {
  const c = String(country ?? "").trim().toUpperCase();
  for (const [region, countries] of Object.entries(REGIONS)) if (countries.includes(c)) return region as SupplierRegion;
  return "unknown";
}
