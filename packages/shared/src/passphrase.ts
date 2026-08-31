/**
 * WHAT A BACKUP PASSPHRASE MAY CONTAIN, WRITTEN ONCE FOR BOTH SIDES.
 *
 * Task 2 discovered the rule and enforced it in services/backup.ts, where it
 * was the API boundary's business alone. Task 3 needs the SAME answer at the
 * keyboard, and needs it to be the same answer rather than a second one that
 * happens to agree: a page that refuses a passphrase the server would have
 * accepted is a page that lies, and a page that accepts one the server refuses
 * hands back a 400 for something it could have said in place, next to the
 * field, while the character was still on the screen.
 *
 * So this module is the single definition and both sides call it -- the same
 * arrangement `logoDataUriProblem` has for the issuer logo, and for the same
 * stated reason: the message here and the server's refusal are one answer.
 *
 * WHY A NEWLINE IS THE ONE THAT MATTERS, and it is not a tidiness rule.
 * Measured by Task 2 on the deploy target: `7z` reads the passphrase as ONE
 * LINE from stdin. Given "abc\ndef" it encrypts with "abc", reports success,
 * and hands back an archive that opens with a passphrase the operator never
 * typed and cannot guess. There is no recovery path for a backup passphrase,
 * so that archive is lost the moment it is written -- and nothing anywhere
 * would have said so. A carriage return is worse: 7z KEEPS it, so the
 * passphrase ends with an invisible character that no Keka or 7-Zip dialog
 * will ever reproduce.
 *
 * Every other control character is refused for the same family of reasons --
 * silently dropped, silently kept, or unenterable in the dialogs this format
 * exists to be opened by. Everything printable is allowed, including spaces
 * (leading and trailing ones survive the pipe -- measured) and every non-ASCII
 * character (a passphrase with umlauts round-trips -- measured).
 */

/**
 * 256 characters. Not a security bound -- there is no upper limit at which a
 * passphrase becomes weak -- but a bound on what travels to a child process's
 * stdin, and a value a person could conceivably retype.
 */
export const MAX_PASSPHRASE_LENGTH = 256;

/**
 * C0 and DEL. Written as an escape range rather than as literal characters so
 * this source file cannot itself carry one, the same discipline auth.ts states
 * for its own forbidden-character class.
 *
 * DELIBERATELY NOT \p{Cc} IN FULL: that would add the C1 block (U+0080-U+009F),
 * and MEASURED ON THE DEPLOY TARGET (7-Zip 26.02) rather than assumed -- a
 * passphrase containing U+0085 (NEL) or U+009F (APC) writes an archive that
 * reopens with those exact bytes, as does one containing U+00A0. So does every
 * other case this rule allows: leading and trailing spaces, umlauts, colons and
 * the whole ASCII punctuation set. The same run reproduced both of Task 2's
 * refusals: with a newline, the archive does NOT open with what was typed and
 * DOES open with the prefix before it; with a carriage return, the archive
 * keeps the invisible character and refuses the prefix. The rule here is "what
 * 7z or a passphrase dialog will silently change", not "what looks unusual".
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/**
 * The one reason this passphrase cannot be used, or null.
 *
 * A SENTENCE, NOT A CODE, because both callers put it in front of a person:
 * the page prints it under the field and the route sends it as the message of
 * a 400. It says what 7z would DO rather than naming the character class,
 * because "control character" is not a thing anybody believes they typed.
 */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase === "") {
    return "a passphrase is required; a backup is never written unencrypted";
  }
  if (CONTROL_CHARACTERS.test(passphrase)) {
    return "the passphrase must not contain line breaks, tabs or other control characters: "
      + "7z reads it up to the first line break, which would encrypt the backup with "
      + "something other than what you typed";
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    return `the passphrase must be at most ${String(MAX_PASSPHRASE_LENGTH)} characters`;
  }
  return null;
}
