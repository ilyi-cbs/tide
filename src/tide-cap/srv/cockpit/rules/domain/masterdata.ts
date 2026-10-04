// Pure domain of the rule lists (P-13): no CDS, no I/O, "today" is the asOf parameter.
import {
  ACTIVE_MONTHS,
  FIELD_WORDS,
  PAIR_FIELDS,
  RECENT_MONTHS,
  type PairField,
} from "./constants";
import { addMonths } from "./texts";
import { groupBy } from "../../kernel/collections";
import Fuse from "fuse.js";

// ---------------------------------------------------------------- activity + duplicates

export interface ActivityRow {
  Material: string;
  Plant?: string | null;
  date: string;
  kind: "po" | "movement";
}

export interface MaterialActivity {
  Material: string;
  recentPOs: number;
  recentMovements: number;
  /** Activity per plant in the 24 months (for scoping a group to a plant). */
  plants: Map<string, number>;
}

/** Materials with a PO or goods movement in the 24 months before asOf, with 12-month counts. */
export function materialActivity(
  rows: ActivityRow[],
  asOf: string,
): Map<string, MaterialActivity> {
  const activeFrom = addMonths(asOf, -ACTIVE_MONTHS);
  const recentFrom = addMonths(asOf, -RECENT_MONTHS);
  const out = new Map<string, MaterialActivity>();
  for (const r of rows) {
    if (!r.Material || !r.date || r.date < activeFrom || r.date >= asOf)
      continue;
    const a =
      out.get(r.Material) ??
      out
        .set(r.Material, {
          Material: r.Material,
          recentPOs: 0,
          recentMovements: 0,
          plants: new Map(),
        })
        .get(r.Material)!;
    if (r.Plant) a.plants.set(r.Plant, (a.plants.get(r.Plant) ?? 0) + 1);
    if (r.date >= recentFrom) {
      if (r.kind === "po") a.recentPOs++;
      else a.recentMovements++;
    }
  }
  return out;
}

export function normaliseDescription(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export interface MaterialRow {
  Product: string;
  ProductType: string | null;
  ProductDescription: string | null;
}

export interface DuplicateMember {
  Product: string;
  ProductDescription: string | null;
  recentPOs: number;
  recentMovements: number;
  similarityScore?: number;
}

export interface DuplicateGroup {
  groupKey: string; // `<type>|<normalised description>`
  ProductType: string;
  description: string;
  members: DuplicateMember[];
  activity: number;
  /** Plant with most activity of the group's members (24 months), null if none. */
  mainPlant: string | null;
  rank: number;
  issue: string;
  issueTechnical: string;
}

/** Groups of active materials with the same normalised description within a material type. */
export function duplicateGroups(
  materials: MaterialRow[],
  activity: Map<string, MaterialActivity>,
): DuplicateGroup[] {
  const seen = new Set<string>();
  const groups = new Map<
    string,
    {
      type: string;
      norm: string;
      members: DuplicateMember[];
      plants: Map<string, number>;
    }
  >();
  const active = [...materials]
    .filter(
      (material) =>
        activity.has(material.Product) &&
        normaliseDescription(material.ProductDescription),
    )
    .sort((left, right) => left.Product.localeCompare(right.Product));
  const byType = groupBy(active, (material) => material.ProductType ?? "");
  const indexes = new Map(
    [...byType].map(([type, members]) => [
      type,
      new Fuse(
        members.map((material) => ({
          ...material,
          normalized: normaliseDescription(material.ProductDescription),
        })),
        {
          keys: ["normalized"],
          includeScore: true,
          ignoreLocation: true,
          ignoreFieldNorm: true,
          threshold: 0.15,
        },
      ),
    ]),
  );
  for (const m of active) {
    if (seen.has(m.Product)) continue;
    seen.add(m.Product);
    const a = activity.get(m.Product);
    if (!a) continue;
    const norm = normaliseDescription(m.ProductDescription);
    if (!norm) continue;
    const type = m.ProductType ?? "";
    const k = `${type}|${norm}`;
    const g =
      groups.get(k) ??
      groups.set(k, { type, norm, members: [], plants: new Map() }).get(k)!;
    const numericTokens = (description: string) =>
      (description.match(/\d+/g) ?? []).join("|");
    const matches = indexes
      .get(type)!
      .search(norm)
      .filter(
        (match) => numericTokens(match.item.normalized) === numericTokens(norm),
      );
    for (const match of matches) {
      if (match.item.Product !== m.Product && seen.has(match.item.Product))
        continue;
      seen.add(match.item.Product);
      const memberActivity = activity.get(match.item.Product)!;
      g.members.push({
        Product: match.item.Product,
        ProductDescription: match.item.ProductDescription,
        recentPOs: memberActivity.recentPOs,
        recentMovements: memberActivity.recentMovements,
        similarityScore:
          match.item.normalized === norm
            ? 100
            : Math.round((1 - (match.score ?? 1)) * 10_000) / 100,
      });
      for (const [plant, count] of memberActivity.plants)
        g.plants.set(plant, (g.plants.get(plant) ?? 0) + count);
    }
  }
  const out = [...groups.entries()]
    .filter(([, g]) => g.members.length > 1)
    .map(([groupKey, g]) => {
      const members = g.members.sort((a, b) =>
        a.Product.localeCompare(b.Product),
      );
      const activitySum = members.reduce(
        (s, x) => s + x.recentPOs + x.recentMovements,
        0,
      );
      const mainPlant =
        [...g.plants.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0]?.[0] ?? null;
      const n = members.length;
      return {
        groupKey,
        ProductType: g.type,
        description: members[0].ProductDescription ?? g.norm,
        members,
        activity: activitySum,
        mainPlant,
        rank: 0,
        issue: members.every((member) => member.similarityScore === 100)
          ? `${n} active materials share the description "${members[0].ProductDescription ?? g.norm}"`
          : `${n} active materials have similar descriptions to "${members[0].ProductDescription ?? g.norm}"`,
        issueTechnical: `material type ${g.type || "blank"}, fuzzy description similarity >= 85%, matching numeric tokens, reference "${g.norm}"; ${activitySum} POs and movements in ${RECENT_MONTHS} months`,
      };
    })
    .sort(
      (a, b) =>
        b.activity - a.activity ||
        b.members.length - a.members.length ||
        a.groupKey.localeCompare(b.groupKey),
    );
  out.forEach((g, i) => (g.rank = i + 1));
  return out;
}

// ---------------------------------------------------------------- rare combinations

export interface PlanningRow {
  Product: string;
  Plant: string;
  ProductType: string | null;
  ProcurementType?: string | null;
  ProcurementSubType?: string | null;
  MRPType?: string | null;
  LotSizingProcedure?: string | null;
  MRPResponsible?: string | null;
}

export interface RarePair {
  a: PairField;
  b: PairField;
  valueA: string;
  valueB: string;
  /** Materials of the type in the plant with valueA / valueB alone, and together (= 1). */
  countA: number;
  countB: number;
  countBoth: number;
}

export interface RareCombination {
  Product: string;
  Plant: string;
  ProductType: string;
  /** Materials of this type in the plant. */
  groupSize: number;
  pairs: RarePair[];
  issue: string;
  issueTechnical: string;
}

const v = (x: unknown) => String(x ?? "").trim();
const shown = (x: string) => (x === "" ? "blank" : x);

/**
 * One finding per material and plant with at least one planning field pair
 * whose value pair occurs once within material type and plant (blank counts
 * as a value). Cells with a single material are not compared.
 */
export function rareCombinations(rows: PlanningRow[]): RareCombination[] {
  const cells = groupBy(rows, (r) => `${v(r.ProductType)}|${r.Plant}`);
  const out: RareCombination[] = [];
  for (const cell of cells.values()) {
    if (cell.length < 2) continue;
    const single = new Map<string, number>();
    const pair = new Map<string, number>();
    const bump = (m: Map<string, number>, k: string) =>
      m.set(k, (m.get(k) ?? 0) + 1);
    for (const r of cell) {
      PAIR_FIELDS.forEach((a, i) => {
        bump(single, `${a}=${v(r[a])}`);
        for (const b of PAIR_FIELDS.slice(i + 1))
          bump(pair, `${a}=${v(r[a])}|${b}=${v(r[b])}`);
      });
    }
    for (const r of cell) {
      const pairs: RarePair[] = [];
      PAIR_FIELDS.forEach((a, i) => {
        for (const b of PAIR_FIELDS.slice(i + 1)) {
          const n = pair.get(`${a}=${v(r[a])}|${b}=${v(r[b])}`)!;
          if (n === 1)
            pairs.push({
              a,
              b,
              valueA: v(r[a]),
              valueB: v(r[b]),
              countA: single.get(`${a}=${v(r[a])}`)!,
              countB: single.get(`${b}=${v(r[b])}`)!,
              countBoth: n,
            });
        }
      });
      if (!pairs.length) continue;
      const p = pairs[0];
      const more = pairs.length > 1 ? ` (and ${pairs.length - 1} more)` : "";
      out.push({
        Product: r.Product,
        Plant: r.Plant,
        ProductType: v(r.ProductType),
        groupSize: cell.length,
        pairs,
        issue:
          `Only material in this plant with ${FIELD_WORDS[p.a]} ${shown(p.valueA)} and ` +
          `${FIELD_WORDS[p.b]} ${shown(p.valueB)}${more}`,
        issueTechnical: pairs
          .map(
            (x) =>
              `${x.a}=${shown(x.valueA)} + ${x.b}=${shown(x.valueB)} once of ${cell.length}`,
          )
          .join("; "),
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.pairs.length - a.pairs.length ||
      a.Plant.localeCompare(b.Plant) ||
      a.Product.localeCompare(b.Product),
  );
}
