// Fractional indexing: produces a string key that sorts, under plain string
// comparison, strictly between two neighbouring keys. Used to order rows
// (pipelines, stages, deals within a stage) so a drag-and-drop move only ever
// needs to write the moved row's position, never renumber its neighbours.
//
// A naive "grow the string by appending a middle digit" scheme (the sketch
// this file replaced) breaks for insert-before-smallest-key cases: growing
// digits onto the low end of the digit alphabet can produce a string that
// sorts AFTER the key it was supposed to precede (e.g. "0" then "0X" > "0").
// The fix is the integer-part/fraction-part scheme below, faithfully ported
// from `generateKeyBetween` in the `fractional-indexing` npm package
// (https://www.npmjs.com/package/fractional-indexing, CC0-1.0 license --
// public domain; the plan that specified this file cited it as MIT, which is
// the license of the algorithm's original write-up at
// https://observablehq.com/@dgreensp/implementing-fractional-indexing, not
// of the npm package itself). Ported rather than depended on so api and web
// share one implementation via packages/shared without adding a runtime
// dependency to either.
//
// A key has a self-delimiting "integer part" (its length is encoded in its
// first character -- see getIntegerLength) followed by a "fraction part" of
// arbitrary length. Repeated inserts between the same two neighbours grow
// the fraction part by roughly one digit each time rather than exploding in
// length, and inserting at either end grows/shrinks the integer part instead
// of ever needing a key "before everything" that cannot be represented.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0]!;
const LAST = DIGITS[DIGITS.length - 1]!;

/** Midpoint within the fraction-part alphabet only (`a`/`b` have no integer part). */
function fractionMidpoint(a: string, b: string | null): string {
  if (b != null && a >= b) throw new Error(`midpoint: ${a} >= ${b}`);
  if (a.endsWith(ZERO) || (b != null && b.endsWith(ZERO))) {
    throw new Error("midpoint: trailing zero digit");
  }
  if (b != null) {
    // Strip the longest common prefix (padding `a` with the zero digit as we
    // go, since `a` cannot run out before `b` while a common prefix holds).
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + fractionMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a.length > 0 ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b != null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) {
    const mid = Math.round(0.5 * (digitA + digitB));
    return DIGITS[mid]!;
  }
  // First digits are consecutive: descend one level.
  if (b != null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + fractionMidpoint(a.slice(1), null);
}

/** Integer-part length is encoded in its first character: A..Z shrink as the
 *  head rises toward Z (down to length 1 at "Z"), a..z grow as the head rises
 *  from a (length 2) upward -- this is what lets the integer part itself keep
 *  growing/shrinking without bound as keys are inserted at either end. */
function getIntegerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`midpoint: invalid order key head: ${head}`);
}

function getIntegerPart(key: string): string {
  const len = getIntegerLength(key[0]!);
  if (len > key.length) throw new Error(`midpoint: invalid order key: ${key}`);
  return key.slice(0, len);
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int[0]!)) {
    throw new Error(`midpoint: invalid integer part of order key: ${int}`);
  }
}

function validateOrderKey(key: string): void {
  if (key === "A" + ZERO.repeat(26)) throw new Error(`midpoint: invalid order key: ${key}`);
  const i = getIntegerPart(key);
  const f = key.slice(i.length);
  if (f.endsWith(ZERO)) throw new Error(`midpoint: invalid order key: ${key}`);
}

/** Returns null when the integer part is already the largest representable ("zzzz...z"). */
function incrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x[0]!;
  const digs = x.slice(1).split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) {
      digs[i] = ZERO;
    } else {
      digs[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") digs.push(ZERO);
  else digs.pop();
  return h + digs.join("");
}

/** Returns null when the integer part is already the smallest representable ("A"). */
function decrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x[0]!;
  const digs = x.slice(1).split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) {
      digs[i] = LAST;
    } else {
      digs[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return "Z" + LAST;
  if (head === "A") return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") digs.push(LAST);
  else digs.pop();
  return h + digs.join("");
}

/**
 * Lexicographic fractional index: returns a string strictly between a and b.
 * null a = beginning, null b = end. Ordering is plain string comparison.
 */
export function midpoint(a: string | null, b: string | null): string {
  if (a != null) validateOrderKey(a);
  if (b != null) validateOrderKey(b);
  if (a != null && b != null && a >= b) throw new Error(`midpoint: ${a} >= ${b}`);

  if (a == null) {
    if (b == null) return "a" + ZERO;
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === "A" + ZERO.repeat(26)) return ib + fractionMidpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res == null) throw new Error("midpoint: cannot decrement any further");
    return res;
  }

  if (b == null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i == null ? ia + fractionMidpoint(fa, null) : i;
  }

  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + fractionMidpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i == null) throw new Error("midpoint: cannot increment any further");
  if (i < b) return i;
  return ia + fractionMidpoint(fa, null);
}
