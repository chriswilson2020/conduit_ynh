import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  NAV_DESTINATIONS,
  PRIMARY_NAV_IDS,
  isAnyNavDestinationActive,
  isNavDestinationActive,
  splitNav,
} from "./nav-lib";

describe("splitNav", () => {
  /**
   * The spec fixes these four and the order they sit in, so this is the pin:
   * a reorder or a swap is a decision to argue for with the coordinator, and
   * it should cost a failing test rather than pass unnoticed.
   */
  it("puts exactly Mail, Companies, Contacts and My Tasks in the bar, in that order", () => {
    const { primary } = splitNav(NAV_DESTINATIONS);
    expect(primary.map((destination) => destination.id)).toEqual(["mail", "companies", "contacts", "my-tasks"]);
    expect(primary.map((destination) => destination.label)).toEqual(["Mail", "Companies", "Contacts", "My Tasks"]);
  });

  it("leaves Pipelines, Projects, Gantt and Settings behind More, in sidebar order", () => {
    const { overflow } = splitNav(NAV_DESTINATIONS);
    expect(overflow.map((destination) => destination.id)).toEqual(["pipelines", "projects", "gantt", "settings"]);
  });

  /**
   * The property the phase's definition of done rests on: the two halves are
   * the whole list, once each. Nothing can be reachable at a desk and nowhere
   * else because the split dropped it.
   */
  it("partitions the destinations -- every one appears exactly once", () => {
    const { primary, overflow } = splitNav(NAV_DESTINATIONS);
    const seen = [...primary, ...overflow].map((destination) => destination.id).sort();
    expect(seen).toEqual(NAV_DESTINATIONS.map((destination) => destination.id).sort());
    expect(new Set(seen).size).toBe(NAV_DESTINATIONS.length);
  });

  it("sends a destination it has never heard of to the overflow rather than dropping it", () => {
    const { primary, overflow } = splitNav([
      { id: "mail" },
      { id: "reports" },
      { id: "companies" },
    ]);
    expect(primary.map((destination) => destination.id)).toEqual(["mail", "companies"]);
    expect(overflow.map((destination) => destination.id)).toEqual(["reports"]);
  });

  it("orders the bar by the primary list, not by the order it was given", () => {
    const { primary } = splitNav([{ id: "my-tasks" }, { id: "contacts" }, { id: "mail" }, { id: "companies" }]);
    expect(primary.map((destination) => destination.id)).toEqual(PRIMARY_NAV_IDS);
  });

  it("skips a primary that is absent rather than inventing it", () => {
    const { primary } = splitNav([{ id: "mail" }, { id: "companies" }]);
    expect(primary.map((destination) => destination.id)).toEqual(["mail", "companies"]);
  });
});

describe("isNavDestinationActive", () => {
  it("is active on the destination's own path", () => {
    expect(isNavDestinationActive("/companies", { match: "/companies" })).toBe(true);
  });

  it("is active on a page below it -- a detail page is somewhere the tab took you", () => {
    expect(isNavDestinationActive("/companies/abc-123", { match: "/companies" })).toBe(true);
  });

  it("is not active on a path that merely starts with the same characters", () => {
    expect(isNavDestinationActive("/companies-archive", { match: "/companies" })).toBe(false);
  });

  /** Settings links at one of its two tabs and must read as current on both. */
  it("is active on either Settings tab", () => {
    const settings = NAV_DESTINATIONS.find((destination) => destination.id === "settings");
    expect(settings).toBeDefined();
    if (settings === undefined) return;
    expect(isNavDestinationActive("/settings/mail", settings)).toBe(true);
    expect(isNavDestinationActive("/settings/templates", settings)).toBe(true);
  });

  it("lights More up for anything inside the sheet, and not for anything in the bar", () => {
    const { primary, overflow } = splitNav(NAV_DESTINATIONS);
    expect(isAnyNavDestinationActive("/settings/templates", overflow)).toBe(true);
    expect(isAnyNavDestinationActive("/pipelines/abc-123", overflow)).toBe(true);
    expect(isAnyNavDestinationActive("/companies/abc-123", overflow)).toBe(false);
    expect(isAnyNavDestinationActive("/companies/abc-123", primary)).toBe(true);
  });
});

/**
 * The phase's scope rule is that nothing the app can do is desktop-only, and
 * the shell is where that is easiest to break: a ninth sidebar entry added
 * later without a matching line in NAV_DESTINATIONS would be reachable at a
 * desk and nowhere else, and no e2e journey would notice because none of them
 * would know to look for it.
 *
 * Reading the sidebar's source is deliberate rather than lazy. shell.tsx keeps
 * its links as hand-written JSX -- this phase may not alter the desktop shell,
 * and rewriting them into a map over this list would do exactly that -- so a
 * runtime assertion has nothing to compare against. Labels are not compared,
 * only targets: the sidebar says "Inbox" where the bar says "Mail".
 */
describe("NAV_DESTINATIONS", () => {
  it("covers exactly the destinations the desktop sidebar links to", () => {
    const shell = readFileSync(new URL("./shell.tsx", import.meta.url), "utf8");
    const linked = [...shell.matchAll(/to="(\/[^"]*)"/g)].map((match) => match[1] ?? "");
    expect(linked.sort()).toEqual(NAV_DESTINATIONS.map((destination) => destination.to).sort());
  });

  it("gives every destination a unique id and target", () => {
    const ids = NAV_DESTINATIONS.map((destination) => destination.id);
    const targets = NAV_DESTINATIONS.map((destination) => destination.to);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(targets).size).toBe(targets.length);
  });
});
