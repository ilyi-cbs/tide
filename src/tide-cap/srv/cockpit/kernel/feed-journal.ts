// Read side of the feed journal: was a source field freshly supplied by the feed?
import cds from "@sap/cds";

const { SELECT } = cds.ql;
const JOURNAL = "tide.cockpit.FeedJournal";

function keysOf(entity: string): string[] {
  const def: any = (cds.model as any)?.definitions[`tide.s4.${entity}`];
  if (!def || def.kind !== "entity") return [];
  return Object.entries<any>(def.elements)
    .filter(([, e]) => e.key && !e.isAssociation && !e.virtual)
    .map(([n]) => n);
}

export async function hasFreshFieldObservation(
  entity: string,
  source: Record<string, unknown>,
  field: string,
  after: string,
): Promise<boolean> {
  return (await freshFieldObservation(entity, source, field, after)) !== null;
}

export async function freshFieldObservation(
  entity: string,
  source: Record<string, unknown>,
  field: string,
  after: string,
): Promise<{ ID: string | number; at: string } | null> {
  if (!Number.isFinite(Date.parse(after))) return null;
  const keys = JSON.stringify(
    Object.fromEntries(keysOf(entity).map((k) => [k, source[k]])),
  );
  const entries: any[] = await SELECT.from(JOURNAL)
    .where({ entity, keys })
    .orderBy("ID desc");
  for (const entry of entries) {
    if (
      !entry.supplied ||
      !Number.isFinite(Date.parse(entry.at)) ||
      Date.parse(entry.at) <= Date.parse(after)
    )
      continue;
    let supplied: Record<string, unknown>;
    try {
      supplied = JSON.parse(entry.supplied);
    } catch {
      continue;
    }
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
      continue;
    if (Object.hasOwn(supplied, field))
      return supplied[field] != null &&
        supplied[field] !== "" &&
        typeof supplied[field] !== "boolean" &&
        Number(supplied[field]) === Number(source[field])
        ? { ID: entry.ID, at: entry.at }
        : null;
  }
  return null;
}
