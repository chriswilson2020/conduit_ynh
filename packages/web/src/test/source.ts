/**
 * Helpers for the source-reading guards in this package's unit tests.
 *
 * WHY THIS FILE EXISTS. Several test files in packages/web assert things about
 * their subject's SOURCE rather than its behaviour -- that a desktop class
 * string is still spelled the way it shipped, that a utility is absent, that a
 * component is rendered exactly once. This repo has no testing-library, so a
 * rule that lives in JSX has no other unit-level check at all. Those guards all
 * need the same preprocessing, and by the third phase of this work two files
 * had grown their own copies that DID NOT AGREE -- one of which was evaded by a
 * URL in the source it was guarding. One implementation, imported, is what
 * stops a fourth author writing a fifth variant.
 *
 * Nothing here is imported by application code; it is only reachable from
 * *.test.ts, so it never reaches a bundle.
 */

/**
 * Source with its comments removed.
 *
 * Every assertion that says a spelling is ABSENT has to run over this, because
 * the comment discipline in this codebase means the things being guarded get
 * NAMED in prose all the time -- and a guard that turns the suite red because
 * someone explained a class in a comment, with a diff that says only
 * "unexpectedly matched", is worse than no guard.
 *
 * LINE COMMENTS ARE MATCHED ONLY WHERE THEY BEGIN A LINE, and that restriction
 * is the whole point rather than an approximation. A `//` can appear inside an
 * ordinary string -- a URL is the obvious one -- and a stripper that removed
 * from any `//` to the end of the line would delete real code after it. That is
 * not hypothetical: a reviewer defeated the looser version by putting a second
 * component behind an `<a href="https://...">`, and the guard that was supposed
 * to catch a duplicated pane stayed green because everything after `https:` had
 * been thrown away. The same trick hides a banned utility from an absence
 * assertion, and a URL sitting before a guarded literal produces the opposite
 * failure -- a spurious red with no explanation. Whole-line comments are this
 * codebase's style, so nothing is lost by matching only those.
 */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Source with its import statements removed, so a guard can ask whether a name
 * is USED rather than merely available.
 *
 * WHY THE DISTINCTION IS NOT PEDANTIC. Nothing in this repo notices an unused
 * import: there is no linter at all, and tsconfig.base.json does not set
 * noUnusedLocals -- so `import { useOwnWriteNonce } ...` with the call deleted
 * compiles, ships, and satisfies any guard that searches the whole file. That
 * is not a hypothetical evasion either; it is the FIRST mutation anyone
 * writes, and v1.7.2's mutation run watched four guards pass against it before
 * this function existed.
 *
 * MULTI-LINE IMPORTS ARE THE COMMON CASE HERE (this package's import lists
 * routinely wrap), which is why this matches across lines up to the `from`
 * clause rather than line by line. Non-greedy, so a file's second import is
 * not swallowed along with its first. The second pass covers the side-effect
 * form, which has no `from`.
 *
 * `export ... from` re-exports are deliberately left alone: a name a module
 * re-exports is part of what that module DOES, not something it happens to
 * have in scope.
 */
export function withoutImports(source: string): string {
  return source
    .replace(/^import\s[\s\S]*?\sfrom\s*["'][^"']*["'];?[ \t]*$/gm, "")
    .replace(/^import\s*["'][^"']*["'];?[ \t]*$/gm, "");
}
