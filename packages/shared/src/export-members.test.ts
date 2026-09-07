import { describe, expect, it } from "vitest";
import {
  EXPORT_MEMBERS, EXPORT_MEMBER_NAMES, MEMBER_BY_TABLE, NOT_IMPORTED_MEMBERS,
  exportMemberNouns, importedMembers,
} from "./export-members.js";

// THE LIST ITSELF CANNOT BE TESTED AGAINST A COPY OF ITSELF, and this file does
// not try. What it holds is the small number of properties a reader of the list
// is entitled to assume -- that no two members share a name, that no table is
// claimed by two sheets, that the not-imported half really is the complement of
// the imported one -- plus the sentence builder, which is the one piece of
// BEHAVIOUR here.
//
// The real guards are elsewhere, and each compares this list against something
// that is not a list: the archive that is actually written
// (services/export.test.ts, routes/export.test.ts), the findings an import
// preview actually emits (services/import-export.test.ts, routes/import.test.ts),
// the database catalogue (`describe("export coverage")`), and the words actually
// on the Settings page (e2e/data.spec.ts).

describe("the export's member list", () => {
  it("names each member once", () => {
    expect([...new Set(EXPORT_MEMBER_NAMES)]).toHaveLength(EXPORT_MEMBERS.length);
  });

  it("gives every member at least one table and claims no table twice", () => {
    const claimed: string[] = [];
    for (const member of EXPORT_MEMBERS) {
      expect(member.tables.length, member.member).toBeGreaterThan(0);
      claimed.push(...member.tables);
    }
    // documents.csv carries four tables; nothing else may carry one of them.
    expect(claimed).toContain("document_quotes");
    const twice = claimed.filter((table, at) => claimed.indexOf(table) !== at);
    expect(twice, "a table carried by two sheets would make MEMBER_BY_TABLE lossy").toEqual([]);
    expect(MEMBER_BY_TABLE.get("document_quotes")).toBe("documents.csv");
    expect(MEMBER_BY_TABLE.size).toBe(claimed.length);
  });

  it("splits into imported and not-imported with nothing in both and nothing in neither", () => {
    const imported = importedMembers();
    const notImported = NOT_IMPORTED_MEMBERS.map((m) => m.member);
    expect([...imported, ...notImported].sort()).toEqual([...EXPORT_MEMBER_NAMES].sort());
    expect(imported.filter((m) => notImported.includes(m))).toEqual([]);
    // Every reason is a sentence somebody wrote, not a placeholder: it is
    // rendered into an operator's import preview verbatim.
    for (const { member, reason } of NOT_IMPORTED_MEMBERS) {
      expect(reason.length, member).toBeGreaterThan(40);
      expect(reason.endsWith("."), `${member}'s reason is punctuated by its caller`).toBe(false);
    }
  });

  it("reads out every member's noun, in archive order, as one English list", () => {
    const nouns = exportMemberNouns();
    for (const member of EXPORT_MEMBERS) {
      expect(nouns, `${member.member} is not named to the operator`).toContain(member.noun);
    }
    // Ordered and joined, not merely present -- this string is read aloud by a
    // person deciding whether their data is in the file.
    expect(nouns.startsWith(`${EXPORT_MEMBERS[0]?.noun ?? ""}, `)).toBe(true);
    expect(nouns.endsWith(` and ${EXPORT_MEMBERS.at(-1)?.noun ?? ""}`)).toBe(true);
    expect(nouns.split(", ")).toHaveLength(EXPORT_MEMBERS.length - 1);
  });
});
