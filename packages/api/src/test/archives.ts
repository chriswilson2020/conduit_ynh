import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

const execFileAsync = promisify(execFile);

/**
 * ARCHIVE FIXTURES FOR 7.7's SPINE, BUILT BY THE SAME BINARY AN OPERATOR HAS.
 *
 * services/intake.ts reads archives with `7z`, so a fixture written by a
 * hand-rolled writer here would share every assumption the reader makes and
 * prove nothing. These drive `7z` itself (and, for the export half, the `yazl`
 * that services/export.ts already ships), so what is staged in a test is the
 * same bytes an operator would hand over.
 *
 * Probed rather than assumed, on backup.test.ts's precedent: a developer on
 * macOS has no /usr/bin/7z and should see a visible skip rather than a red
 * suite. The dev server and the CI runner both have it, which is where the
 * archive path has to hold.
 */
export const HAVE_7Z = await (async () => {
  try {
    await execFileAsync("7z", ["i"]);
    return true;
  } catch {
    return false;
  }
})();

/** Run 7z with a passphrase on stdin -- the shape the spine measured. */
async function runSevenZip(args: readonly string[], passphrase: string | null): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn("7z", args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("close", (code) => { resolve(code ?? -1); });
    if (passphrase !== null) child.stdin.write(passphrase);
    child.stdin.end();
  });
}

/** One file to put in a fixture archive. */
export interface FixtureMember {
  /** Path inside the archive, e.g. "files/ab12". */
  name: string;
  content: Buffer | string;
  /**
   * The unix mode, INCLUDING the file type bits, for the zip writer only --
   * e.g. 0o120777 for a symlink whose content is its target. Omitted for an
   * ordinary file.
   */
  mode?: number;
}

/**
 * Write a `.7z` with `-mhe=on`, exactly as services/backup.ts does.
 *
 * ABSOLUTE INPUTS, because that is what makes the layout a property of the
 * format rather than of the deployment -- 7z strips the parent of an absolute
 * input and keeps a bare relative one as written, which is the bug 7.6 shipped
 * and then fixed with path.resolve. A fixture that used relative inputs would
 * produce an archive one directory deeper than any real backup.
 */
export async function writeSevenZip(options: {
  archivePath: string;
  workDir: string;
  members: readonly FixtureMember[];
  passphrase: string;
  /** Extra roots to add after the members, e.g. a directory holding a symlink. */
  extraInputs?: readonly string[];
}): Promise<void> {
  const { archivePath, workDir, members, passphrase } = options;
  const roots = new Set<string>();
  for (const member of members) {
    const full = path.join(workDir, member.name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, member.content);
    const top = member.name.split("/")[0] ?? member.name;
    roots.add(path.resolve(path.join(workDir, top)));
  }
  const inputs = [...roots, ...(options.extraInputs ?? []).map((i) => path.resolve(i))];
  const code = await runSevenZip(
    ["a", "-t7z", "-p", "-mhe=on", "-mx=1", "-bd", "-y", "--", archivePath, ...inputs],
    passphrase,
  );
  if (code !== 0) throw new Error(`7z a exited ${String(code)} building ${archivePath}`);
}

/**
 * Write a `.7z` carrying a member whose stored path escapes with `..`.
 *
 * `-spf` (store FULL paths) is what makes this possible, and it is the reason
 * archiveMemberProblem refuses a `..` component rather than trusting 7z to
 * sanitise: the stock binary will write one, on request, with no warning.
 */
export async function writeTraversalSevenZip(options: {
  archivePath: string;
  /** The directory 7z is run from; the members are named relative to it. */
  cwd: string;
  /**
   * Members to store verbatim, relative to cwd. One ending in "/" is created as
   * an EMPTY DIRECTORY, which is how a fixture isolates the path rule from the
   * kind rule -- an escaping directory full of escaping files would be refused
   * for its files and prove nothing about its directory.
   */
  relativeMembers: readonly string[];
  passphrase: string;
}): Promise<void> {
  const { archivePath, cwd, relativeMembers, passphrase } = options;
  for (const member of relativeMembers) {
    const target = path.join(cwd, member);
    if (member.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "escaped");
    }
  }
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "7z",
      [
        "a", "-t7z", "-p", "-mhe=on", "-mx=1", "-bd", "-y", "-spf", "--", archivePath,
        ...relativeMembers.map((member) => member.replace(/\/$/, "")),
      ],
      { cwd, stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", reject);
    child.on("close", (code) => { resolve(code ?? -1); });
    child.stdin.write(passphrase);
    child.stdin.end();
  });
  if (code !== 0) throw new Error(`7z a -spf exited ${String(code)}`);
}

/**
 * Write a `.7z` whose `files/` directory holds symlinks -- one absolute, one
 * relative and escaping.
 *
 * 7z PRESERVES SYMLINKS AND RECREATES THEM -- measured on the deploy target
 * (7-Zip 26.02 via p7zip 16.02), where the absolute link came back re-rooted
 * inside the destination and the relative one escaping the destination made
 * `7z x` exit 2 while still writing a file in its place. Two behaviours for one
 * idea, neither of them a refusal, which is why the spine decides it from the
 * index instead.
 *
 * `-snl` IS TRIED FIRST AND IS NOT COSMETIC, AND THE BEHAVIOUR IS PER BUILD
 * RATHER THAN UNIVERSAL. The deploy target (7-Zip 26.02 via p7zip 16.02) stores
 * symlinks WITHOUT the switch -- measured -- and the CI runner's build did not:
 * this fixture built there without `-snl`, staged cleanly, and the test
 * asserting a refusal failed because there was nothing to refuse. So the switch
 * is asked for and the plain form is the fallback, rather than either being
 * declared correct; a build that rejects the switch outright (p7zip 16.02 exits
 * non-zero on an unknown one) still gets the form that works for it.
 *
 * The caller is expected to VERIFY what was stored -- see readSevenZipIndex --
 * rather than assume this worked, because the point of the fixture is the link
 * and an archive that quietly lost it proves nothing.
 */
export async function writeSymlinkSevenZip(options: {
  archivePath: string;
  workDir: string;
  passphrase: string;
}): Promise<void> {
  const { archivePath, workDir, passphrase } = options;
  const dir = path.join(workDir, "files");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "aaaa"), "real");
  await rm(path.join(dir, "abs"), { force: true });
  await rm(path.join(dir, "escape"), { force: true });
  await symlink("/etc/passwd", path.join(dir, "abs"));
  await symlink("../../../../etc/passwd", path.join(dir, "escape"));

  const base = ["a", "-t7z", "-p", "-mhe=on", "-mx=1", "-bd", "-y"];
  const inputs = ["--", archivePath, path.resolve(dir)];
  let code = await runSevenZip([...base, "-snl", ...inputs], passphrase);
  if (code !== 0) {
    await rm(archivePath, { force: true });
    code = await runSevenZip([...base, ...inputs], passphrase);
  }
  if (code !== 0) throw new Error(`7z a exited ${String(code)} building ${archivePath}`);
}

/** One member of an archive, as `7z l -slt` reports it. For fixture checks. */
export interface IndexedMember { path: string; attributes: string }

/**
 * What an archive ACTUALLY holds, read back with `7z l -slt`.
 *
 * A FIXTURE THAT IS NOT VERIFIED IS NOT A FIXTURE. The symlink archive above is
 * the case in point: it was built, it exited 0, and on one platform it carried
 * no symlink at all -- so the test that depended on it was asserting a refusal
 * of something that was not there. This is how a test checks its own premise
 * and says what it found when the premise fails.
 */
export async function readSevenZipIndex(
  archivePath: string, passphrase: string | null,
): Promise<IndexedMember[]> {
  const listing = await new Promise<string>((resolve, reject) => {
    const child = spawn("7z", ["l", "-slt", "-bd", "-y", "--", archivePath], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", () => { resolve(out); });
    if (passphrase !== null) child.stdin.write(passphrase);
    child.stdin.end();
  });
  const lines = listing.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "----------");
  if (start === -1) return [];
  const members: IndexedMember[] = [];
  let current: Partial<IndexedMember> = {};
  const flush = (): void => {
    if (current.path !== undefined) {
      members.push({ path: current.path, attributes: current.attributes ?? "" });
    }
    current = {};
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") { flush(); continue; }
    if (line.startsWith("Path = ")) { flush(); current.path = line.slice(7); }
    else if (line.startsWith("Attributes = ")) { current.attributes = line.slice(13); }
  }
  flush();
  return members;
}

/**
 * Write a plain `.zip` with yazl -- the same library services/export.ts uses,
 * so an "import Conduit's own export" fixture is built by the code that writes
 * the real thing rather than by an approximation of it.
 */
export async function writeZip(options: {
  zipPath: string;
  members: readonly FixtureMember[];
}): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const member of options.members) {
    // `mode` IS WHAT LETS A ZIP FIXTURE CARRY A SYMLINK. yazl writes it into the
    // external file attributes, which is the only place a zip records a unix
    // file type -- so `0o120777` produces a member `7z x` recreates as a link,
    // and a member `7z l -slt` describes with an EMPTY DOS field. That empty
    // field is the shape that got past the index rule, and no fixture could
    // reach it before this option was used.
    zip.addBuffer(Buffer.from(member.content), member.name,
      member.mode === undefined ? undefined : { mode: member.mode });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(options.zipPath));
}

/** The SHA-256 of a buffer, as a blob's filename is in Conduit's blob store. */
export function digestOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
