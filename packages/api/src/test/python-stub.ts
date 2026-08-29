import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shadowing the renderer, so the paths that matter most run everywhere.
 *
 * `documents-render.ts` spawns a bare `python3`, and Node resolves a bare command
 * name against `env.PATH` at spawn time -- while renderPdf builds the child's env
 * from `process.env` -- so putting a directory at the front of PATH is enough to
 * intercept every render this process makes.
 *
 * WHY THIS IS WORTH A HELPER RATHER THAN A COPY IN EACH SUITE: without it, every
 * failure path (a renderer that exits non-zero, one that hangs, one that emits
 * nothing) is testable only on a machine that has WeasyPrint -- which is backwards
 * for code whose entire job is failing well. It also buys something no real renderer
 * can give: a stub can emit DIFFERENT bytes on every invocation, which is what turns
 * "the stored PDF never changes" from a tautology into a claim.
 */

/**
 * Write an executable `python3` with `body` as its shell script into a fresh
 * directory under `baseDir`, and return that directory for PATH.
 */
export function writePythonStub(baseDir: string, body: string): string {
  const dir = mkdtempSync(join(baseDir, "bin-"));
  const file = join(dir, "python3");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/**
 * Run `fn` with `dir` at the front of PATH, or as the whole of PATH when `replace`
 * is set (which is how "there is no interpreter at all" is expressed).
 *
 * PATH is restored in a `finally`, so a failing assertion inside `fn` cannot leak a
 * stub into the rest of the file.
 */
export async function withPythonStub<T>(
  dir: string, fn: () => Promise<T>, replace = false,
): Promise<T> {
  const original = process.env.PATH ?? "";
  process.env.PATH = replace ? dir : `${dir}:${original}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}
