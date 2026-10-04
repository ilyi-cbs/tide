// Shared role checks keep admins distinct from buyers missing scope attributes.
export function isAdmin(
  user: { is?: (r: string) => boolean; roles?: any } | undefined,
): boolean {
  if (!user) return false;
  return typeof user.is === "function" ? user.is("admin") : !!user.roles?.admin;
}

export interface Scope {
  PurchasingGroup: string | null;
  Plant: string | null;
  isAdmin: boolean;
  grants?: Array<{ Plant: string; PurchasingGroup: string }>;
}

const one = (value: unknown): string | null => {
  const values = [
    ...new Set(
      (Array.isArray(value) ? value : [value])
        .filter((entry) => entry != null && entry !== "")
        .map(String),
    ),
  ];
  return values.length === 1 ? values[0] : null;
};

export function scopeOf(user: {
  is?: (r: string) => boolean;
  roles?: any;
  attr?: Record<string, unknown>;
}): Scope {
  const admin = isAdmin(user);
  const attributes = user.attr ?? {};
  const candidates = attributes.ScopeGrants ?? [
    { Plant: attributes.Plant, PurchasingGroup: attributes.PurchasingGroup },
  ];
  const grants = Array.isArray(candidates)
    ? candidates.filter(
        (grant): grant is { Plant: string; PurchasingGroup: string } =>
          grant &&
          typeof grant.Plant === "string" &&
          !!grant.Plant &&
          typeof grant.PurchasingGroup === "string" &&
          !!grant.PurchasingGroup,
      )
    : [];
  return admin
    ? { PurchasingGroup: null, Plant: null, isAdmin: true }
    : {
        PurchasingGroup: one(grants.map((grant) => grant.PurchasingGroup)),
        Plant: one(grants.map((grant) => grant.Plant)),
        isAdmin: false,
        grants,
      };
}

export function inScope(
  scope: Scope,
  row: { PurchasingGroup?: string | null; Plant?: string | null },
): boolean {
  if (scope.isAdmin) return true;
  if (!row.Plant || !row.PurchasingGroup) return false;
  const grants =
    scope.grants ??
    (scope.Plant && scope.PurchasingGroup
      ? [{ Plant: scope.Plant, PurchasingGroup: scope.PurchasingGroup }]
      : []);
  return grants.some(
    (grant) =>
      grant.Plant === row.Plant &&
      grant.PurchasingGroup === row.PurchasingGroup,
  );
}

export function inCommandScope(
  user: {
    is?: (role: string) => boolean;
    roles?: any;
    attr?: Record<string, unknown>;
  },
  row: { PurchasingGroup?: string | null; Plant?: string | null },
): boolean {
  return inScope(scopeOf(user), row);
}
