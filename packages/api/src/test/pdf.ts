import { inflateSync } from "node:zlib";

/**
 * READING A PDF IN A TEST, WITHOUT ASSERTING ONE VERSION'S REPRESENTATION.
 *
 * WeasyPrint 61.1 (the Ubuntu 24.04 CI runner) compresses object streams by default;
 * 57.2 (the Debian 12 server) does not. So a name, a URI or a page tree is plain text
 * on one machine and invisible on the other, and a raw byte search over the file
 * passes here and fails there -- or worse, passes here and passes there VACUOUSLY,
 * when the assertion is a negative one.
 *
 * That trap has now cost three CI rounds in three different tasks: Task 1 on
 * `/EmbeddedFiles`, Task 2 on the page tree, and Task 3 on a `/URI` string. This
 * module exists so the fourth one does not have to be a fourth copy of the same loop.
 *
 * The reader itself is pinned by documents-seed.test.ts against a hand-built PDF
 * whose page tree exists ONLY inside a compressed object stream -- no renderer of any
 * version involved, which is the only way to prove it against the machine you are not
 * sitting at.
 */

/** The PDF's bytes plus every Flate stream in it, inflated, as one searchable string. */
export function pdfText(pdf: Buffer): string {
  const parts = [pdf.toString("latin1")];
  let from = 0;
  for (;;) {
    const start = pdf.indexOf("stream", from);
    if (start === -1) break;
    const end = pdf.indexOf("endstream", start);
    if (end === -1) break;
    let body = start + "stream".length;
    if (pdf[body] === 0x0d) body += 1;
    if (pdf[body] === 0x0a) body += 1;
    try {
      parts.push(inflateSync(pdf.subarray(body, end)).toString("latin1"));
    } catch {
      // Not a Flate stream, or not a stream at all. Keep looking.
    }
    // Past the whole "endstream" keyword, not one byte into it: resuming at end + 1
    // makes the next search match the "stream" inside it, whose paired "endstream" is
    // the FOLLOWING object's -- which silently skips every other stream in the file.
    from = end + "endstream".length;
  }
  return parts.join("\n");
}

/** Pages, from the page tree's own count rather than by counting page objects. */
export function pageCount(pdf: Buffer): number {
  const counts = (pdfText(pdf).match(/\/Count\s+(\d+)/g) ?? []).map((m) => Number(/\d+/.exec(m)![0]));
  // An intermediate node carries its own subtree's count, so the root's is the
  // largest -- true whatever shape the producer gives the tree.
  return counts.length === 0 ? 0 : Math.max(...counts);
}

/** An image XObject: what a `data:` logo becomes, and what an absent one does not. */
export function pdfHasImage(pdf: Buffer): boolean {
  return /\/Subtype\s*\/Image/.test(pdfText(pdf));
}
