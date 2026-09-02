import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A FOREIGN CSV WRITTEN BY SOFTWARE THAT IS NOT THIS REPO.
 *
 * 7.7's definition of done asks for "a real foreign CSV -- not a fixture that
 * resembles one", and a fixture assembled by joining strings in TypeScript is
 * exactly the thing it rules out: it would share every assumption
 * services/csv.ts makes and would prove nothing about a file somebody else
 * wrote. So these bytes come out of PYTHON'S OWN `csv` MODULE, whose `excel`
 * dialect is an independent implementation of the same format, written by
 * people who never saw this codebase -- the same argument test/archives.ts
 * makes for driving `7z` rather than writing an archive by hand.
 *
 * WHAT IS REAL AND WHAT IS NOT, said plainly rather than left to be assumed.
 * The BYTES are real: the quoting, the escaping, the line terminator and the
 * BOM are all Python's decisions, and the header rows below are the ones
 * Outlook and a European Excel actually write. The CONTENT is invented, because
 * a genuine customer list is not a thing to commit to a repository.
 *
 * A DEVELOPER WITHOUT python3 SEES A SKIP, on backup.test.ts's precedent, and
 * the `it.runIf(CI)` case in import-csv.test.ts is what makes an unexpected
 * absence loud rather than silent. CI installs weasyprint and python3-munkres,
 * so python3 is there; so is it on the deploy target.
 */
export const HAVE_PYTHON = await (async () => {
  try {
    await execFileAsync("python3", ["-c", "import csv, json, sys"]);
    return true;
  } catch {
    return false;
  }
})();

/**
 * The script python3 runs. It reads one JSON object from stdin and writes the
 * file, so nothing a test supplies is ever interpolated into source that Python
 * will parse -- a value containing a quote or a newline is the whole point of
 * these fixtures and must not be able to break the writer that produces them.
 */
const WRITER = [
  "import csv, json, sys",
  "spec = json.load(sys.stdin)",
  "csv.register_dialect('conduit_fixture',",
  "    delimiter=spec['delimiter'],",
  "    lineterminator=spec['lineterminator'],",
  "    quoting=csv.QUOTE_MINIMAL)",
  "with open(spec['path'], 'w', newline='', encoding=spec['encoding']) as fh:",
  "    writer = csv.writer(fh, dialect='conduit_fixture')",
  "    for row in spec['rows']:",
  "        writer.writerow(row)",
].join("\n");

export interface ForeignCsvSpec {
  /** Where to write it. */
  path: string;
  /** The header row, then the data rows. Written by Python, verbatim. */
  rows: readonly (readonly string[])[];
  /** Default ",". ";" is what a European Excel writes. */
  delimiter?: string;
  /** Default "\r\n", which is what `csv.excel` uses. */
  lineterminator?: string;
  /** "utf-8-sig" writes the BOM Excel writes. Default "utf-8". */
  encoding?: "utf-8" | "utf-8-sig";
}

/**
 * Write a foreign CSV with Python, and hand back the bytes it produced.
 *
 * THE BYTES ARE RETURNED SO A TEST CAN CHECK ITS OWN PREMISE. test/archives.ts
 * learned this the hard way: a fixture that was built, exited 0 and carried no
 * symlink at all made a test assert a refusal of something that was not there.
 * A test that wants a semicolon file should assert that what came back has
 * semicolons in it.
 */
export async function writeForeignCsv(spec: ForeignCsvSpec): Promise<Buffer> {
  const payload = JSON.stringify({
    path: spec.path,
    rows: spec.rows,
    delimiter: spec.delimiter ?? ",",
    lineterminator: spec.lineterminator ?? "\r\n",
    encoding: spec.encoding ?? "utf-8",
  });
  // THE SPEC GOES OVER STDIN AND NEVER INTO ARGV, and not only for tidiness: a
  // fixture's whole job here is to carry a quote, a newline or a NUL, and a
  // value on a command line is a value some shell or some limit gets to have an
  // opinion about.
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn("python3", ["-c", WRITER], { stdio: ["pipe", "ignore", "pipe"] });
    let captured = "";
    child.stderr.on("data", (chunk: Buffer) => { captured += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(captured);
      else reject(new Error(`python3 exited ${String(code)}: ${captured.slice(0, 400)}`));
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
  if (stderr !== "") throw new Error(`python3 wrote to stderr: ${stderr.slice(0, 400)}`);
  return await readFile(spec.path);
}

/**
 * The header row Microsoft Outlook writes when it exports contacts to CSV.
 *
 * ABRIDGED TO THE COLUMNS THAT MATTER AND NOT INVENTED: Outlook's real sheet
 * has around eighty columns, most of them empty for most people, and the
 * fixture keeps a representative slice -- the three email columns that are the
 * reason `contact.email` is repeatable, a "Company" column that is a NAME and
 * not an id, and several columns Conduit has nowhere to put, which is the "a
 * header row it does not recognise" case the spec asks this importer to handle.
 */
export const OUTLOOK_CONTACT_HEADER: readonly string[] = [
  "First Name", "Middle Name", "Last Name", "Title", "Suffix",
  "Company", "Department", "Job Title",
  "Business Street", "Business City", "Business Postal Code", "Business Country/Region",
  "Business Phone", "Home Phone", "Mobile Phone",
  "E-mail Address", "E-mail 2 Address", "E-mail 3 Address",
  "Web Page", "Notes",
];
