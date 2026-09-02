/**
 * HOW THE TYPED CONFIRMATION IS COMPARED WITH THE INSTALL'S NAME, WRITTEN ONCE
 * FOR BOTH SIDES.
 *
 * Chris ruled that a restore is confirmed by typing the install's name.
 * routes/restore.ts's `installName` decides WHAT that name is -- the database
 * this install is connected to -- and its own comment carries the reasoning at
 * length. This module is the other half: the comparison, which 7.7 Task 3 wrote
 * for the route alone and 7.7 Task 4 needs at the keyboard as well.
 *
 * IT IS HERE RATHER THAN IN THE PAGE FOR THE REASON passphrase.ts IS HERE, and
 * on this rule the reason is sharper. The page must be able to say "that is not
 * the name" BEFORE it spends a re-authentication ticket, because a ticket is
 * single-use and a typo would otherwise cost the operator their password again.
 * The server's 400 is still the control. But two implementations of one
 * comparison is exactly the shape 7.7's review found five defects in -- two
 * layers each masking the other's mutation -- so there is ONE function and two
 * callers, not two rules that agree today.
 *
 * TRIMMED AND OTHERWISE EXACT. Surrounding whitespace is dropped because a
 * copy-paste picks it up and refusing that teaches the operator nothing; case
 * is not folded and nothing else is normalised, because every relaxation makes
 * the string easier to produce without having read it, which is the entire
 * property being bought.
 *
 * NOT A TIMING-SAFE COMPARISON, and that is a statement rather than an
 * oversight: the name is PRINTED ON THE PAGE next to the field, and it is
 * echoed in the 400 body when it does not match. It is a deliberateness check,
 * not a secret, and treating it as one would suggest to the next reader that it
 * is -- which would in turn suggest that the confirmation, rather than the
 * re-authentication behind it, is what stops a stranger.
 */
export function installNameMatches(typed: string, expected: string): boolean {
  return typed.trim() === expected;
}
