// Result card of a prediction on request (P-8) in the chat: the reality check
// in a box, the verdict, the top rows (at most 20), the counts and "Add to
// worklist" after a pass. Ported from the prototype's PredictionCard.jsx.
// No percentages and no scores: the ranking orders the rows, it is not a
// promise. Expert numbers stay in a closed "How was this checked?" section.
import type { AssistantCard } from "./AssistantController";

const VERDICT: Record<string, { text: string; design: string }> = {
  pass: { text: "Reliable enough", design: "Positive" },
  fail: { text: "Not reliable", design: "Negative" },
  "too little": { text: "Not enough history", design: "Critical" },
};

const COLS = {
  rank: "#",
  po: "PO item",
  material: "Material",
  supplier: "Supplier",
  requested: "Requested",
  range: "Likely duration",
};
export const SHOWN = (k: number, n: number) =>
  `top ${k} of ${n}, ranked by the AI estimate; the order matters, it is not a promise`;
export const RANGE = (x: unknown, a: unknown, b: unknown) =>
  `about ${x} days, likely ${a} to ${b}`;
export const ALREADY_LATE = (n: number, days: unknown) =>
  `${n} open items already more than ${days} days late, not predicted`;
const FILTER_WORDS: Record<string, string> = {
  plant: "plant",
  purchasingGroup: "purchasing group",
  supplier: "supplier",
  supplierRegion: "supplier region",
  materialType: "material type",
  materialGroup: "material group",
  material: "material",
  poDateFrom: "ordered from",
  poDateTo: "ordered to",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function rows(p: Record<string, any>): HTMLElement {
  const range = p.target === "lead_time_days";
  const wrap = el("div", "assistantCardRows");
  const table = el("table");
  table.dataset.testid = "prediction-rows";
  const head = el("tr");
  for (const h of [
    COLS.rank,
    COLS.po,
    COLS.material,
    COLS.supplier,
    COLS.requested,
    ...(range ? [COLS.range] : []),
  ])
    head.append(el("th", undefined, h));
  const thead = el("thead");
  thead.append(head);
  const body = el("tbody");
  for (const r of p.rows ?? []) {
    const tr = el("tr");
    tr.dataset.testid = "prediction-row";
    const po = r.PurchaseOrderItem
      ? `${r.PurchaseOrder} / ${r.PurchaseOrderItem}`
      : String(r.PurchaseOrder);
    const poCell = el("td");
    if (typeof r.link === "string" && r.link.startsWith("#/")) {
      const a = el("a", undefined, po);
      a.href = r.link;
      poCell.append(a);
    } else poCell.textContent = po;
    tr.append(
      el("td", undefined, String(r.rank)),
      poCell,
      el("td", undefined, r.Material ?? ""),
      el("td", undefined, r.Supplier ?? ""),
      el("td", undefined, r.RequestedDate ?? ""),
    );
    if (range)
      tr.append(el("td", undefined, RANGE(r.p50Days, r.p10Days, r.p90Days)));
    body.append(tr);
  }
  table.append(thead, body);
  wrap.append(
    table,
    el("small", undefined, SHOWN((p.rows ?? []).length, p.openItems ?? 0)),
  );
  return wrap;
}

export function renderCard(card: AssistantCard): HTMLElement {
  const p = card.data;
  const root = el("section", "assistantCard");
  root.dataset.testid = `${card.kind}-card`;
  if (card.kind !== "prediction") {
    root.append(el("pre", undefined, JSON.stringify(p, null, 2)));
    return root;
  }
  const header = el("div", "assistantCardHeader");
  header.append(
    el("strong", undefined, `Prediction: ${p.targetText ?? p.target}`),
  );
  const v = VERDICT[p.verdict] ?? {
    text: String(p.verdict),
    design: "Information",
  };
  const tag = el(
    "span",
    `assistantCardVerdict assistantCardVerdict--${v.design}`,
    v.text,
  );
  tag.dataset.testid = "prediction-verdict";
  header.append(tag);
  root.append(header);
  const filters = Object.entries(p.filters ?? {})
    .map(([k, value]) => `${FILTER_WORDS[k] ?? k} ${value}`)
    .join(" · ");
  if (filters) root.append(el("small", "assistantCardFilters", filters));
  const reality = el(
    "div",
    "assistantCardReality",
    p.realityCheck ?? p.check?.summary ?? "",
  );
  reality.dataset.testid = "prediction-reality";
  root.append(reality);
  if (p.verdict !== "pass" && p.answer)
    root.append(el("p", "assistantCardAnswer", p.answer));
  if (p.alreadyLate > 0)
    root.append(
      el("small", undefined, ALREADY_LATE(p.alreadyLate, p.lateDays)),
    );
  if ((p.rows ?? []).length) root.append(rows(p));
  const expert = el("details", "assistantCardExpert");
  expert.append(el("summary", undefined, "How was this checked?"));
  const c = p.check ?? {};
  expert.append(
    el(
      "small",
      undefined,
      `${c.evaluated ?? p.evaluated ?? 0} evaluated; ${p.notEvaluated ?? ""}; cutoff ${c.cutoff ?? ""}`,
    ),
  );
  const warnings = el("div", "assistantCardWarnings");
  for (const warning of p.warnings ?? []) {
    warnings.append(el("p", "assistantCardWarning", String(warning)));
  }
  if (warnings.childElementCount) root.append(warnings);
  root.append(expert);
  return root;
}
