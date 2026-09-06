import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, timeZoneProblem } from "@conduit/shared";
import { supportedTimeZones, timeZoneOptions } from "./settings-org-lib";

describe("timeZoneOptions", () => {
  it("puts UTC first, because it is the default and the list does not contain it", () => {
    const options = timeZoneOptions("UTC", ["Europe/Amsterdam", "Africa/Abidjan"]);
    expect(options[0]).toBe(DEFAULT_TIME_ZONE);
    expect(options).toEqual(["UTC", "Africa/Abidjan", "Europe/Amsterdam"]);
  });

  /**
   * THE FAILURE THIS PREVENTS IS SILENT AND IS NOT A CRASH. A `<select>` whose
   * `value` matches no `<option>` shows nothing selected and submits the FIRST
   * option -- so a stored zone the browser's list happens not to carry would be
   * replaced by Africa/Abidjan the next time anybody saved the form, on a page
   * they opened to change the phone number.
   */
  it("keeps a stored zone the platform's list does not carry", () => {
    const options = timeZoneOptions("Asia/Kolkata", ["Africa/Abidjan", "Asia/Calcutta"]);
    expect(options).toContain("Asia/Kolkata");
    expect(options).toContain("Asia/Calcutta");
  });

  it("keeps a stored zone that is not a zone at all, so the page can show what is wrong", () => {
    // A row can hold this after an ICU retires a name, or after a restore from
    // another install. Dropping it would hide the evidence on the one page that
    // can fix it.
    const options = timeZoneOptions("Factory", ["Africa/Abidjan"]);
    expect(options).toContain("Factory");
    expect(timeZoneProblem("Factory")).not.toBeNull();
  });

  it("does not offer the empty string, which cannot be chosen meaningfully", () => {
    expect(timeZoneOptions("", ["Africa/Abidjan"])).toEqual(["UTC", "Africa/Abidjan"]);
  });

  it("lists UTC once, however many times the inputs mention it", () => {
    expect(timeZoneOptions("UTC", ["UTC", "Africa/Abidjan", "UTC"]))
      .toEqual(["UTC", "Africa/Abidjan"]);
  });

  it("still yields a usable picker when the platform lists nothing", () => {
    // The ES2022 guard's outcome: a browser without supportedValuesOf gets the
    // default and whatever is stored, not an empty select.
    expect(timeZoneOptions("Europe/Amsterdam", [])).toEqual(["UTC", "Europe/Amsterdam"]);
  });

  /**
   * THE PICKER MAY NOT OFFER SOMETHING THE SERVER WILL REFUSE. `timeZoneProblem`
   * is the gate on both sides; this is the assertion that the option list and the
   * gate agree, over the real platform list rather than a fixture of three.
   */
  it("offers nothing the server would refuse", () => {
    const options = timeZoneOptions("UTC", supportedTimeZones());
    expect(options.length).toBeGreaterThan(100);
    expect(options.map((zone) => [zone, timeZoneProblem(zone)] as const)
      .filter(([, problem]) => problem !== null)).toEqual([]);
  });
});

describe("supportedTimeZones", () => {
  it("reads the platform's own list rather than one shipped in this repository", () => {
    const zones = supportedTimeZones();
    expect(zones).toContain("Europe/Amsterdam");
    // ...and the two absences that make timeZoneOptions necessary at all.
    expect(zones).not.toContain("UTC");
    expect(zones.filter((zone) => zone.startsWith("Etc/"))).toEqual([]);
  });
});
