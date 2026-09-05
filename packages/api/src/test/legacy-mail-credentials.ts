/**
 * PRE-PHASE-8 CREDENTIAL BLOBS, WRITTEN BY THE OLD ENCODER.
 *
 * WHY THIS FILE EXISTS AT ALL. Phase 8 turns mail-crypto.ts's credential
 * schema from a strict `{ imapPassword, smtpPassword }` object into a union
 * that also admits an OAuth shape. Every mail password on an existing install
 * is an AES-256-GCM blob written under the old shape, and `mail.key` is the
 * only thing that can read it: if the new schema stops accepting that shape,
 * every stored password is stranded and only a backup gets them back.
 *
 * A ROUND-TRIP THROUGH THE NEW CODE CANNOT PROVE THAT. `encrypt(decrypt(x))`
 * only proves the new code agrees with itself -- it would pass unchanged if
 * the new encoder and the new decoder had BOTH moved to a shape no stored row
 * has. The blobs below are therefore not generated at test time. They were
 * produced once, by the encoder as it stood BEFORE any Phase 8 edit, and
 * pasted here as constants.
 *
 * PROVENANCE, so this is checkable rather than merely asserted:
 *
 *   commit .................. 9924b58e871017e17a432a79e760ca67acda8cf8
 *                             ("docs(plan): Phase 8 in four tasks, credential
 *                             union first" -- the last commit before the union)
 *   mail-crypto.ts blob ..... 84b1a50f06b00b8e32d7060c749fb08682cad3c3
 *
 *   `git cat-file -p 84b1a50f06b00b8e32d7060c749fb08682cad3c3` is the exact
 *   source that wrote these strings. To regenerate, check that blob out into a
 *   scratch file and call its `encryptCredentials` with LEGACY_MAIL_KEY_BASE64 below. Do
 *   NOT regenerate them with the current encoder: a fixture written by the code
 *   under test is the failed version of this proof, not the passed one.
 *
 * THE KEY IS COMMITTED, AND THAT IS FINE. It is 32 random bytes generated for
 * this file and used nowhere else -- not Chris's `mail.key`, not any install's.
 * The "passwords" it protects are invented. Committing it is what makes the
 * blobs decryptable by a test that has no filesystem state to inherit, which is
 * the entire point; the alternative (a key generated per run) could only
 * decrypt a blob generated in the same run, which is the round trip this file
 * exists to avoid.
 */
export const LEGACY_MAIL_KEY_BASE64 = "Qzejt9++5ow7VKgYnrmgypgOyN/KGstL5YPoAMBLnbA=";

export interface LegacyCredentialBlob {
  /** Names the case in test output. */
  readonly name: string;
  /** Exactly the string a pre-Phase-8 `credentials_ciphertext` column holds. */
  readonly ciphertext: string;
  /** What the old encoder was handed, and therefore what must come back. */
  readonly imapPassword: string;
  readonly smtpPassword: string;
}

export const LEGACY_PASSWORD_BLOBS: readonly LegacyCredentialBlob[] = [
  {
    // Distinct halves on purpose: an identical pair would still pass if the new
    // decrypter swapped the two fields, and "SMTP differs" accounts are exactly
    // the ones where that would be silent and wrong.
    name: "distinct imap and smtp passwords",
    ciphertext:
      "v1:AuSCOAS9DNnneKFq:0zMyf6bTfAjkt0v35H+0YA==:TtruCKhMi4cWcTaN6/KomQu47qtKzaqy2yWSvk5OPifhmFmaJgmKySaHBDSn8R5X2jm7qHuXw5b9PTNA1InJpWk7i/ky1g3R3RVFyyWIukfd",
    imapPassword: "legacy-imap-hunter2",
    smtpPassword: "legacy-smtp-correct-horse",
  },
  {
    // Every character class that could survive a naive round-trip test and
    // still break here: a colon (the ciphertext's OWN field separator, so a
    // decoder that ever split the plaintext would trip), a double quote and a
    // backslash (JSON escaping), a Latin-1 letter, a NO-BREAK SPACE, and an
    // astral-plane emoji (the utf8 decode, and a surrogate pair).
    //
    // WRITTEN AS \u ESCAPES, and that is not stylistic. The first draft of this
    // fixture spelled these characters literally in both the generator and the
    // expectation, and a NO-BREAK SPACE (U+00A0) reached the generator where a
    // plain space was intended. The test failed with a diff whose two sides
    // rendered IDENTICALLY on screen -- the only thing that distinguished them
    // was dumping the code points. Escapes make the bytes readable; a literal
    // here can be silently wrong and look right.
    name: "colon, quote, backslash, NO-BREAK SPACE and an astral emoji in the password",
    ciphertext:
      "v1:d9KGMDoUlNJezj7W:vvy7Fq9bAv60PZr4rQLGWQ==:jMTqMrXHJwPS3SueMTLzb/hzA2qtrzZnhRYgSYygsk4bOK5TvE/bkLDFZuYgQcAXKcCDUhfAiR1GKodBZoOXL0DAwy7omFaD4wE39ICoRw==",
    imapPassword: "p:a\"s\\s w\u00f6rd\u00a0\u{1f510}",
    smtpPassword: "p:a\"s\\s w\u00f6rd\u00a0\u{1f510}",
  },
];
