// Pure guard logic: cost model, limit, buyers, scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetLimit,
  DEFAULT_LIMIT,
  deriveBuyers,
  inScope,
  mockedUsers,
  scopeOf,
} from "../srv/cockpit/guard/domain/logic";

test("budget limit: env wins, then config, then the default", () => {
  assert.equal(budgetLimit("7", 20), 7);
  assert.equal(budgetLimit(undefined, 20), 20);
  assert.equal(budgetLimit("abc", undefined), DEFAULT_LIMIT);
  assert.equal(budgetLimit("-1", "3"), 3);
});

test("one buyer per purchasing group, plant only when unique", () => {
  const b = deriveBuyers(
    [
      { PurchasingGroup: "D02", Plant: "DE11" },
      { PurchasingGroup: "A01", Plant: "AT21" },
      { PurchasingGroup: "A01", Plant: "AT21" },
      { PurchasingGroup: "D02", Plant: "DE31" },
      { PurchasingGroup: null, Plant: "DE11" },
    ],
    new Map([["A01", "Vienna team"]]),
  );
  assert.deepEqual(b, [
    {
      userId: "buyerA01",
      name: "Vienna team",
      PurchasingGroup: "A01",
      Plant: "AT21",
    },
    {
      userId: "buyerD02",
      name: "Buyer D02",
      PurchasingGroup: "D02",
      Plant: null,
    },
  ]);
  const users = mockedUsers(b);
  assert.deepEqual(users.buyerA01, {
    password: "buyerA01",
    roles: ["user"],
    attr: { PurchasingGroup: "A01", Plant: "AT21" },
  });
  assert.deepEqual(users.buyerD02.attr, { PurchasingGroup: "D02" });
});

test("scope: admin sees all, buyer only its group and plant", () => {
  const admin = scopeOf({ is: (r) => r === "admin" || r === "user", attr: {} });
  assert.ok(
    admin.isAdmin && inScope(admin, { PurchasingGroup: "X", Plant: "Y" }),
  );
  const buyer = scopeOf({
    is: () => false,
    attr: { PurchasingGroup: "A01", Plant: "AT21" },
  });
  assert.deepEqual(buyer, {
    PurchasingGroup: "A01",
    Plant: "AT21",
    isAdmin: false,
    grants: [{ Plant: "AT21", PurchasingGroup: "A01" }],
  });
  assert.ok(inScope(buyer, { PurchasingGroup: "A01", Plant: "AT21" }));
  assert.ok(!inScope(buyer, { PurchasingGroup: "A02", Plant: "AT21" }));
  assert.ok(!inScope(buyer, { PurchasingGroup: "A01", Plant: "DE11" }));
  assert.ok(
    !inScope(buyer, { Plant: "AT21" }),
    "rows without a group are outside every grant",
  );
  const unconfigured = scopeOf({ is: () => false, attr: {} });
  assert.equal(inScope(unconfigured, {}), false);
  assert.equal(
    inScope(unconfigured, { PurchasingGroup: "A01", Plant: "AT21" }),
    false,
  );
  const groupOnly = scopeOf({
    is: () => false,
    attr: { PurchasingGroup: "A01" },
  });
  assert.equal(
    inScope(groupOnly, { PurchasingGroup: "A01", Plant: "DE11" }),
    false,
  );
});
