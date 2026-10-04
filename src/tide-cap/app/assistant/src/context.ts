/** Stable, deliberately small context contract shared by assistant hosts. */
export const COCKPIT_SURFACES = [
  "cockpit.overview",
  "cockpit.delivery-risk-list",
  "cockpit.delivery-risk-detail",
  "cockpit.open-item",
  "cockpit.prevention-list",
  "cockpit.prevention-case",
  "cockpit.customer-detail",
  "cockpit.approvals",
  "cockpit.requests",
  "cockpit.planning",
  "cockpit.proof",
  "cockpit.help",
] as const;

export type CockpitSurface = (typeof COCKPIT_SURFACES)[number];
export type AssistantAppId = "cockpit";
export type AssistantSurface = CockpitSurface;
export type AssistantEntityKind =
  "case" | "finding" | "purchase-order-item" | "customer";

export interface AssistantPageContextV1 {
  [key: string]: unknown;
  version: 1;
  app: AssistantAppId;
  surface: AssistantSurface;
  entity?: { kind: AssistantEntityKind; id: string };
  selection?: { itemIds?: string[] };
  filters?: {
    plant?: string;
    purchasingGroup?: string;
    supplier?: string;
  };
  /** UI-only label; never sent to the agent. */
  title?: string;
}

export interface AssistantContextProvider {
  getContext(): AssistantPageContextV1 | null;
  subscribe?(listener: () => void): () => void;
}

export interface AssistantPromptTemplate {
  id: string;
  label: string;
  prompt: string;
}

export function defaultPageContext(app: string): AssistantPageContextV1 | null {
  if (app === "cockpit")
    return {
      version: 1,
      app,
      surface: "cockpit.overview",
      title: "Buyer cockpit",
    };
  return null;
}

const GENERIC_PROMPTS: AssistantPromptTemplate[] = [
  {
    id: "what-can-i-check",
    label: "What can I check?",
    prompt: "What can I check here?",
  },
  {
    id: "priorities",
    label: "Top priorities",
    prompt: "What should I focus on first?",
  },
];

const SURFACE_PROMPTS: Partial<
  Record<AssistantSurface, AssistantPromptTemplate[]>
> = {
  "cockpit.overview": [
    {
      id: "today",
      label: "Summarize today",
      prompt: "Summarize today's most important purchasing issues.",
    },
    {
      id: "priorities",
      label: "Top priorities",
      prompt: "Which orders matter most and why?",
    },
    {
      id: "actions",
      label: "Pending actions",
      prompt: "What actions are waiting for a decision?",
    },
  ],
  "cockpit.delivery-risk-list": [
    {
      id: "top-risks",
      label: "Top delivery risks",
      prompt: "Which delivery risks should I address first?",
    },
    {
      id: "evidence",
      label: "Show the evidence",
      prompt: "Summarize the evidence behind the highest delivery risks.",
    },
  ],
  "cockpit.delivery-risk-detail": [
    {
      id: "why-listed",
      label: "Why is this listed?",
      prompt: "Why is this delivery risk listed and what should I do next?",
    },
    {
      id: "evidence",
      label: "Show evidence",
      prompt: "What evidence supports this delivery risk?",
    },
    {
      id: "next-step",
      label: "Recommended next step",
      prompt: "What is the recommended next step, and why?",
    },
  ],
  "cockpit.open-item": [
    {
      id: "why-item",
      label: "Why is this item listed?",
      prompt: "Why is this purchase order item listed and what should I do?",
    },
    {
      id: "customer-impact",
      label: "Customer impact",
      prompt:
        "What customer impact is associated with this purchase order item?",
    },
  ],
  "cockpit.prevention-list": [
    {
      id: "anomalies",
      label: "Explain the cases",
      prompt: "Summarize the prevention cases that need review.",
    },
    {
      id: "next-review",
      label: "What should I review?",
      prompt: "Which prevention case should I review first and why?",
    },
  ],
  "cockpit.prevention-case": [
    {
      id: "why-case",
      label: "Why was this detected?",
      prompt:
        "Why was this case detected? Explain the evidence and recommended review.",
    },
    {
      id: "evidence",
      label: "Show supporting evidence",
      prompt: "What evidence supports this case?",
    },
  ],
  "cockpit.customer-detail": [
    {
      id: "customer-impact",
      label: "Explain the impact",
      prompt:
        "Explain this customer's exposure using the available purchasing data.",
    },
    {
      id: "affected-orders",
      label: "Affected orders",
      prompt: "Which affected orders should I review first?",
    },
  ],
  "cockpit.approvals": [
    {
      id: "pending",
      label: "Summarize pending decisions",
      prompt: "Summarize the decisions waiting in Approvals.",
    },
  ],
  "cockpit.requests": [
    {
      id: "requests",
      label: "Review requests",
      prompt: "Which requests need my attention and why?",
    },
  ],
  "cockpit.planning": [
    {
      id: "planning",
      label: "Explain the plan",
      prompt: "Summarize the current planning view and its main risks.",
    },
  ],
  "cockpit.proof": [
    {
      id: "proof",
      label: "Explain the proof",
      prompt: "Explain what the current proof results establish.",
    },
  ],
  "cockpit.help": [
    {
      id: "how-it-works",
      label: "How does this work?",
      prompt: "Explain how this cockpit workflow works.",
    },
  ],
};

export function promptsForContext(
  context: AssistantPageContextV1 | null | undefined,
): AssistantPromptTemplate[] {
  return context ? (SURFACE_PROMPTS[context.surface] ?? GENERIC_PROMPTS) : [];
}

/** Remove display-only and unknown properties before a context crosses the API boundary. */
export function apiContext(
  context: AssistantPageContextV1 | Record<string, unknown> | null | undefined,
  app: AssistantAppId = "cockpit",
): AssistantPageContextV1 | null {
  if (!context) return null;
  if (typeof context !== "object" || Array.isArray(context)) return null;
  const raw = context as Record<string, unknown>;
  const candidate = context as Partial<AssistantPageContextV1>;
  const surface = candidate.surface ?? "cockpit.overview";
  if (!(COCKPIT_SURFACES as readonly string[]).includes(surface)) return null;
  const result: AssistantPageContextV1 = {
    version: 1,
    app,
    surface,
  };
  const itemIDs = Array.isArray(raw.itemIDs) ? raw.itemIDs : [];
  const legacyEntity =
    typeof raw.caseID === "string"
      ? { kind: "case" as const, id: raw.caseID }
      : typeof raw.findingID === "string"
        ? { kind: "finding" as const, id: raw.findingID }
        : typeof raw.customer === "string"
          ? { kind: "customer" as const, id: raw.customer }
          : typeof itemIDs[0] === "string"
            ? { kind: "purchase-order-item" as const, id: itemIDs[0] }
            : null;
  const entity = legacyEntity ?? candidate.entity;
  if (
    entity &&
    ["case", "finding", "purchase-order-item", "customer"].includes(
      entity.kind,
    ) &&
    typeof entity.id === "string" &&
    entity.id.length > 0
  )
    result.entity = { kind: entity.kind, id: entity.id.slice(0, 160) };
  const selected = Array.isArray(raw.itemIDs)
    ? raw.itemIDs
    : Array.isArray(candidate.selection?.itemIds)
      ? candidate.selection.itemIds
      : [];
  if (selected.length)
    result.selection = {
      itemIds: selected
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
        .map((item) => item.slice(0, 32)),
    };
  if (candidate.filters && typeof candidate.filters === "object") {
    result.filters = {
      ...(typeof candidate.filters.plant === "string"
        ? { plant: candidate.filters.plant.slice(0, 4) }
        : {}),
      ...(typeof candidate.filters.purchasingGroup === "string"
        ? { purchasingGroup: candidate.filters.purchasingGroup.slice(0, 3) }
        : {}),
      ...(typeof candidate.filters.supplier === "string"
        ? { supplier: candidate.filters.supplier.slice(0, 10) }
        : {}),
    };
  }
  return result;
}
