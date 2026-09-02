import { describe, expect, it } from "vitest";
import {
  destructiveEffects, planIsApplicable, plannedTotal,
  type PlanEffectView, type PlanView,
} from "./plan.js";

// THE POINT OF THIS FILE IS THAT IT NEEDS NOTHING. No database, no archive, no
// disk, no destruction -- because a plan is a value, and every question worth
// asking about a restore before it runs is a question about that value.

function effect(overrides: Partial<PlanEffectView> = {}): PlanEffectView {
  return {
    op: "insert-rows",
    subject: "companies",
    count: 1,
    unit: "row",
    destroys: false,
    detail: "",
    ...overrides,
  };
}

function plan(overrides: Partial<PlanView> = {}): PlanView {
  return {
    planId: "11111111-1111-4111-8111-111111111111",
    kind: "import-csv",
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:30:00.000Z",
    source: {
      filename: "contacts.csv", bytes: 10, sha256: "0".repeat(64),
      stagedBytes: 10, memberCount: 1,
    },
    effects: [effect()],
    findings: [],
    refusal: null,
    ...overrides,
  };
}

describe("planIsApplicable", () => {
  it("accepts a plan with effects and no refusal", () => {
    expect(planIsApplicable(plan())).toBe(true);
  });

  it("refuses a plan that carries a refusal", () => {
    expect(planIsApplicable(plan({
      refusal: { code: "newer-schema", message: "taken by a newer Conduit" },
    }))).toBe(false);
  });

  it("refuses a plan with nothing to do", () => {
    expect(planIsApplicable(plan({ effects: [] }))).toBe(false);
  });
});

describe("destructiveEffects", () => {
  it("finds only the effects that destroy, in plan order", () => {
    const view = plan({
      effects: [
        effect({ op: "drop-schema", subject: "public", destroys: true, unit: "schema" }),
        effect({ op: "load-dump", subject: "database.sql", destroys: false }),
        effect({ op: "replace-key", subject: "mail.key", destroys: true, unit: "key" }),
      ],
    });
    expect(destructiveEffects(view).map((e) => e.subject)).toEqual(["public", "mail.key"]);
  });

  // AN IMPORT MUST BE ABLE TO SAY "NOTHING HERE IS DESTROYED" AND BE RIGHT.
  // The Settings page has to keep restore and import visibly apart, and this is
  // the predicate that lets it do so from the plan rather than from the label.
  it("is empty for a plan that creates only", () => {
    expect(destructiveEffects(plan())).toEqual([]);
  });
});

describe("plannedTotal", () => {
  it("sums only the requested unit", () => {
    const view = plan({
      effects: [
        effect({ count: 200_000, unit: "row" }),
        effect({ count: 14, unit: "row", subject: "deals" }),
        effect({ count: 312, unit: "file", subject: "files" }),
      ],
    });
    expect(plannedTotal(view, "row")).toBe(200_014);
    expect(plannedTotal(view, "file")).toBe(312);
    expect(plannedTotal(view, "table")).toBe(0);
  });
});
