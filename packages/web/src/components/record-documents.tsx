import { useState } from "react";
import type { FormEvent } from "react";
import {
  AGREEMENT_FIELD_CAPS, AGREEMENT_MAX_TERM_MONTHS, LETTER_FIELD_CAPS,
} from "@conduit/shared";
import type {
  IssueAgreementInput, IssueLetterInput, LetterRecord, RecordDocument,
} from "@conduit/shared";
import { apiUrl } from "../api";
import { todayLocalIso } from "../lib";
import {
  useIssueRecordDocument, useRecordDocuments, useRedraftLetter,
  type DocumentRecordTarget,
} from "../queries";
import { submitErrorText } from "./document-form";
import { RichTextEditor } from "./mail/rich-text";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

/**
 * A COMPANY'S OR A CONTACT'S DOCUMENTS -- Phase 9 Task 3.
 *
 * **A SECTION ON THE PAGE, NOT A SIXTH TAB IN THE RAIL, AND THE DEAL'S OWN
 * SECTION ALREADY MADE THAT ARGUMENT** -- "the rail is SHARED by the company,
 * contact, deal and project pages and a document belongs to a deal alone; a sixth
 * tab there would be empty on three of the four." Half of that reason has now
 * expired: after this task documents belong to three of the four, and after Task
 * 4 they will belong to all of them.
 *
 * It is still a section, and the decision is deliberate rather than inherited.
 * Consolidating into a rail tab means moving the deal's existing Documents
 * section into it -- a refactor of a shipped surface, with its e2e specs and its
 * `deal-documents` test id, in the same release as three new types and a new
 * guard. And the rail's tab strip is a Phase 6 responsive surface with a measured
 * claim about the LAST tab being reachable on a phone (e2e/mobile.spec.ts), so a
 * sixth tab is a change to something that was measured rather than reasoned. **The
 * consolidation is Task 4's, with four records in front of it instead of three,
 * and it should be flagged as a decision rather than absorbed.**
 *
 * (The spec and the plan both say "a record's Documents TAB". The codebase has
 * never had one: the deal's is a section on the page, and this is that shape
 * copied. Naming it here so the mismatch is on the record.)
 *
 * ONE COMPONENT FOR BOTH RECORDS, because a company and a contact carry exactly
 * the same two types with exactly the same forms. The target is a union, so a
 * caller cannot pass both or neither.
 */
export function RecordDocumentsSection({
  target, archived, defaultRecipientName, defaultRecipientContactName,
  defaultRecipientSalutation, defaultRecipientAddress,
}: {
  target: DocumentRecordTarget;
  /** An archived record refuses a new document in the service, so the buttons are
   * disabled rather than left to produce a 409 the reader has to read. */
  archived: boolean;
  defaultRecipientName: string;
  defaultRecipientContactName: string;
  defaultRecipientSalutation: string;
  defaultRecipientAddress: string;
}) {
  const { data: documents = [], isLoading, error } = useRecordDocuments(target);
  const [open, setOpen] = useState<"letter" | "nda" | "mutual_nda" | null>(null);
  const [redrafting, setRedrafting] = useState<LetterRecord | null>(null);

  const defaults = {
    recipientName: defaultRecipientName,
    recipientContactName: defaultRecipientContactName,
    recipientSalutation: defaultRecipientSalutation,
    recipientAddress: defaultRecipientAddress,
  };

  return (
    <div data-testid="record-documents" className="mt-4 rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Documents</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="new-letter-button"
            disabled={archived}
            onClick={() => setOpen("letter")}
          >
            New letter
          </Button>
          <Button
            variant="outline"
            data-testid="new-nda-button"
            disabled={archived}
            onClick={() => setOpen("nda")}
          >
            New NDA
          </Button>
          <Button
            variant="outline"
            data-testid="new-mutual-nda-button"
            disabled={archived}
            onClick={() => setOpen("mutual_nda")}
          >
            New mutual NDA
          </Button>
        </div>
      </div>

      {/*
        ONE DIALOG PER FORM, OPENED FROM A `useState` RATHER THAN FROM A
        DialogTrigger, because there are three buttons and two forms and a
        trigger per button would nest the same dialog three times. The content is
        only mounted while it is open (`open === ...`), which is what gives the
        rich-text editor a fresh document per opening -- exactly the remount the
        composer relies on, since RichTextEditor reads `initialHtml` once.
      */}
      <Dialog open={open === "letter"} onOpenChange={(next) => { if (!next) setOpen(null); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {open === "letter" && (
            <LetterForm
              target={target}
              defaults={defaults}
              onDone={() => setOpen(null)}
              onCancel={() => setOpen(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={open === "nda" || open === "mutual_nda"}
        onOpenChange={(next) => { if (!next) setOpen(null); }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {(open === "nda" || open === "mutual_nda") && (
            <AgreementForm
              target={target}
              type={open}
              defaults={defaults}
              onDone={() => setOpen(null)}
              onCancel={() => setOpen(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/*
        THE REDRAFT DIALOG IS SEPARATE FROM THE NEW-LETTER ONE, and keyed by the
        letter's id, because it is seeded with that letter's body -- and
        RichTextEditor takes `initialHtml` ONCE. Reusing one dialog would show the
        first letter opened for the rest of the session.
      */}
      <Dialog
        open={redrafting !== null}
        onOpenChange={(next) => { if (!next) setRedrafting(null); }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {redrafting !== null && (
            <LetterForm
              key={redrafting.id}
              target={target}
              redrafting={redrafting}
              defaults={defaults}
              onDone={() => setRedrafting(null)}
              onCancel={() => setRedrafting(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <div className="px-4 py-3">
        {archived && (
          <p className="mb-2 text-xs text-slate-500">
            Unarchive this record to write a letter or raise an agreement.
          </p>
        )}
        {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            Could not load documents: {error.message}
          </p>
        )}
        {!isLoading && !error && documents.length === 0 && (
          <p data-testid="record-documents-empty" className="text-sm text-slate-400">
            No documents yet. A letter or an NDA raised here is stored on this record as a PDF.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              onRedraft={() => { if (document.type === "letter") setRedrafting(document); }}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

const TYPE_LABEL: Record<RecordDocument["type"], string> = {
  letter: "Letter",
  nda: "NDA",
  mutual_nda: "Mutual NDA",
};

/**
 * One row of the mixed list.
 *
 * **THE REDRAFT BUTTON IS GATED ON `frozen` AND NOT ON `type`**, which is the
 * whole per-type freezing rule arriving where a person can see it. The two are
 * equivalent today -- a letter is the one unfrozen type here -- and reading the
 * column is what makes this row honest the day a type is added: a `type ===
 * "letter"` test would keep hiding the button from a future editable type, and
 * `documents_frozen_matches_type` is what guarantees the column says the truth.
 *
 * A FROZEN ROW SAYS SO IN WORDS. "Issued 2026-09-06" beside a Download link tells
 * a reader nothing about why one row has a Redraft button and the next does not;
 * "Frozen on issue" is the answer to the question the absence raises.
 */
function DocumentRow({ document, onRedraft }: {
  document: RecordDocument;
  onRedraft: () => void;
}) {
  const heading = document.type === "letter"
    ? (document.subject.trim() === "" ? document.recipientName : document.subject)
    : `${document.number} — ${document.partyName}`;
  return (
    <li
      data-testid={`record-document-${document.id}`}
      className="flex items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 max-md:flex-col max-md:items-stretch"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{heading}</p>
        <p className="truncate text-xs text-slate-400">
          {`${TYPE_LABEL[document.type]} · ${document.issueDate}`}
          {document.frozen ? " · Frozen on issue" : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3 max-md:justify-between">
        {!document.frozen && (
          <Button
            variant="outline"
            data-testid={`record-document-redraft-${document.id}`}
            onClick={onRedraft}
          >
            Redraft
          </Button>
        )}
        {/* A plain anchor with the 44px floor spelled on it, exactly as the
            deal's Documents section does it -- that comment explains why this is
            not copied from the rail's own bare download link. */}
        <a
          href={apiUrl(`/files/${document.fileId}/download`)}
          data-testid={`record-document-download-${document.id}`}
          className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-slate-900 underline hover:bg-slate-50 max-md:min-h-11"
        >
          Download
        </a>
      </div>
    </li>
  );
}

interface RecipientDefaults {
  recipientName: string;
  recipientContactName: string;
  recipientSalutation: string;
  recipientAddress: string;
}

/**
 * WRITE A LETTER, OR REDRAFT ONE. ONE COMPONENT FOR BOTH, because a redraft is
 * not a patch -- it is the letter written again, on the same form, with the same
 * validation. `redraftLetterInputSchema` is the issue schema minus its `type`,
 * and this is the client side of that.
 *
 * THE BODY IS THE RICH-TEXT EDITOR THE COMPOSER AND THE MEETING NOTES ALREADY
 * USE, which is what the plan means by "reuses the composer and the sanitiser":
 * the markup this produces goes to the server, through the DOCUMENT sanitiser
 * (not mail's), and out as a `MergeHtml` into the page. Nothing new was built for
 * it.
 *
 * `initialHtml` IS READ ONCE AND THAT IS WHY THE CALLER KEYS THIS COMPONENT.
 * TipTap owns the document after it mounts, so seeding a redraft means mounting a
 * fresh editor -- the dialog's own unmount-on-close does that for a new letter,
 * and the `key` on the redraft dialog does it when a different letter is opened.
 */
function LetterForm({ target, redrafting, defaults, onDone, onCancel }: {
  target: DocumentRecordTarget;
  /** The letter being rewritten, or undefined for a new one. */
  redrafting?: LetterRecord;
  defaults: RecipientDefaults;
  onDone: () => void;
  onCancel: () => void;
}) {
  const issue = useIssueRecordDocument();
  const redraft = useRedraftLetter();
  const [draft, setDraft] = useState(() => ({
    // Today in the LOCAL calendar, from the one clock reader this app has --
    // `todayLocalIso`, for the reason document-form.tsx gives: toISOString would
    // date a letter written on a European evening to the previous day.
    //
    // A REDRAFT KEEPS THE LETTER'S OWN DATE rather than moving it to today. The
    // operator may be fixing a typo in a letter dated last week, and silently
    // re-dating it is a change they did not ask for; the field is right there if
    // they want today.
    issueDate: redrafting?.issueDate ?? todayLocalIso(),
    subject: redrafting?.subject ?? "",
    recipientName: redrafting?.recipientName ?? defaults.recipientName,
    recipientContactName: redrafting?.recipientContactName ?? defaults.recipientContactName,
    recipientSalutation: redrafting?.recipientSalutation ?? defaults.recipientSalutation,
    recipientAddress: redrafting?.recipientAddress ?? defaults.recipientAddress,
  }));
  const [bodyHtml, setBodyHtml] = useState(redrafting?.bodyHtml ?? "");
  const [error, setError] = useState<string | null>(null);

  const pending = issue.isPending || redraft.isPending;
  const patch = (over: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...over }));

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const input = {
      issueDate: draft.issueDate,
      subject: draft.subject,
      recipientName: draft.recipientName,
      recipientContactName: draft.recipientContactName,
      recipientSalutation: draft.recipientSalutation,
      recipientAddress: draft.recipientAddress,
      bodyHtml,
    };
    const onError = (err: unknown) => setError(submitErrorText(err));
    if (redrafting !== undefined) {
      redraft.mutate(
        { documentId: redrafting.id, target, input },
        { onSuccess: onDone, onError },
      );
      return;
    }
    issue.mutate(
      { target, input: { type: "letter", ...input } satisfies IssueLetterInput },
      { onSuccess: onDone, onError },
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} data-testid="letter-form">
      <DialogTitle>{redrafting === undefined ? "New letter" : "Redraft letter"}</DialogTitle>

      <Field label="Date">
        <Input
          type="date"
          required
          value={draft.issueDate}
          data-testid="letter-issue-date"
          onChange={(event) => patch({ issueDate: event.target.value })}
        />
      </Field>
      <Field label="Subject">
        <Input
          value={draft.subject}
          maxLength={LETTER_FIELD_CAPS.subject}
          data-testid="letter-subject"
          onChange={(event) => patch({ subject: event.target.value })}
        />
      </Field>
      <Field label="Addressed to">
        <Input
          required
          value={draft.recipientName}
          maxLength={LETTER_FIELD_CAPS.name}
          data-testid="letter-recipient-name"
          onChange={(event) => patch({ recipientName: event.target.value })}
        />
      </Field>
      <Field label="For the attention of">
        <Input
          value={draft.recipientContactName}
          maxLength={LETTER_FIELD_CAPS.contactName}
          data-testid="letter-recipient-contact-name"
          onChange={(event) => patch({ recipientContactName: event.target.value })}
        />
      </Field>
      <Field label="Greeting">
        <Input
          value={draft.recipientSalutation}
          maxLength={LETTER_FIELD_CAPS.salutation}
          placeholder="Ms Smith"
          data-testid="letter-recipient-salutation"
          onChange={(event) => patch({ recipientSalutation: event.target.value })}
        />
      </Field>
      <Field label="Address">
        <Textarea
          rows={3}
          value={draft.recipientAddress}
          maxLength={LETTER_FIELD_CAPS.address}
          data-testid="letter-recipient-address"
          onChange={(event) => patch({ recipientAddress: event.target.value })}
        />
      </Field>

      {/* A <div>, not a <label>: the editor is a contenteditable, which is not a
          labelable element, so a wrapping label would associate with nothing while
          swallowing clicks meant for the editor. The accessible name comes from
          ariaLabel. Copied deliberately from the meeting notes editor, which
          learned it first. */}
      <div className="flex flex-col gap-1 text-xs font-medium text-slate-500">
        <span>Letter</span>
        <RichTextEditor
          testId="letter-body"
          ariaLabel="Letter body"
          initialHtml={redrafting?.bodyHtml}
          onChange={setBodyHtml}
        />
      </div>

      {error !== null && (
        <p role="alert" data-testid="letter-error" className="text-sm text-red-600">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" data-testid="letter-submit" disabled={pending}>
          {pending ? "Rendering..." : redrafting === undefined ? "Write letter" : "Redraft"}
        </Button>
      </div>
    </form>
  );
}

/**
 * RAISE AN NDA OR A MUTUAL NDA. The three fields the spec names -- effective
 * date, term and jurisdiction -- plus the party, and nothing else.
 *
 * **THERE IS NO BODY FIELD AND THAT IS THE DESIGN.** An agreement's prose is the
 * TEMPLATE, which is editable in Settings by whoever is responsible for the
 * wording; a free-text box on this form would let each agreement say something
 * different with nothing reviewing it. The letter has a body because a letter IS
 * its body.
 *
 * ONE FORM FOR BOTH TYPES, because they take the same input. What differs is what
 * the template says about it.
 */
function AgreementForm({ target, type, defaults, onDone, onCancel }: {
  target: DocumentRecordTarget;
  type: "nda" | "mutual_nda";
  defaults: RecipientDefaults;
  onDone: () => void;
  onCancel: () => void;
}) {
  const issue = useIssueRecordDocument();
  const [draft, setDraft] = useState(() => ({
    issueDate: todayLocalIso(),
    // DEFAULTED TO TODAY AND SEPARATELY EDITABLE. An NDA is routinely effective
    // from a date already past -- the conversation started before the paperwork
    // -- so this is a field and not a copy of the issue date, and nothing relates
    // the two.
    effectiveDate: todayLocalIso(),
    termMonths: "36",
    jurisdiction: "",
    partyName: defaults.recipientName,
    partyContactName: defaults.recipientContactName,
    partyAddress: defaults.recipientAddress,
  }));
  const [error, setError] = useState<string | null>(null);
  const patch = (over: Partial<typeof draft>) =>
    setDraft((current) => ({ ...current, ...over }));

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const input: IssueAgreementInput = {
      type,
      issueDate: draft.issueDate,
      effectiveDate: draft.effectiveDate,
      // `Number("")` IS 0 AND NOT NaN, which the schema then refuses with "too
      // small" rather than "expected a number". Both are refusals and neither is
      // reachable through the form -- the input is `required` with a `min` -- so
      // this is about a submission that got here another way, and the schema is
      // what answers it either way.
      termMonths: Number(draft.termMonths),
      jurisdiction: draft.jurisdiction,
      partyName: draft.partyName,
      partyContactName: draft.partyContactName,
      partyAddress: draft.partyAddress,
    };
    issue.mutate({ target, input }, {
      onSuccess: onDone,
      onError: (err) => setError(submitErrorText(err)),
    });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} data-testid="agreement-form">
      <DialogTitle>{type === "nda" ? "New NDA" : "New mutual NDA"}</DialogTitle>
      <p className="text-xs text-slate-500">
        Frozen on issue: once this is raised it cannot be edited, and a corrected
        agreement is a new one with a new number.
      </p>

      <Field label="Date">
        <Input
          type="date"
          required
          value={draft.issueDate}
          data-testid="agreement-issue-date"
          onChange={(event) => patch({ issueDate: event.target.value })}
        />
      </Field>
      <Field label="Effective from">
        <Input
          type="date"
          required
          value={draft.effectiveDate}
          data-testid="agreement-effective-date"
          onChange={(event) => patch({ effectiveDate: event.target.value })}
        />
      </Field>
      <Field label="Term (months)">
        <Input
          type="number"
          required
          min={1}
          max={AGREEMENT_MAX_TERM_MONTHS}
          value={draft.termMonths}
          data-testid="agreement-term-months"
          onChange={(event) => patch({ termMonths: event.target.value })}
        />
      </Field>
      <Field label="Governing law">
        <Input
          required
          value={draft.jurisdiction}
          maxLength={AGREEMENT_FIELD_CAPS.jurisdiction}
          placeholder="the Netherlands"
          data-testid="agreement-jurisdiction"
          onChange={(event) => patch({ jurisdiction: event.target.value })}
        />
      </Field>
      <Field label="Other party">
        <Input
          required
          value={draft.partyName}
          maxLength={AGREEMENT_FIELD_CAPS.name}
          data-testid="agreement-party-name"
          onChange={(event) => patch({ partyName: event.target.value })}
        />
      </Field>
      {/*
        CHRIS'S "EXACTLY ONE" DECISION, AS A FORM FIELD. An NDA with a contact at
        a company attaches to the COMPANY and names the contact in its content --
        this is that content. The label says what the page will say.
      */}
      <Field label="Acting through">
        <Input
          value={draft.partyContactName}
          maxLength={AGREEMENT_FIELD_CAPS.contactName}
          data-testid="agreement-party-contact-name"
          onChange={(event) => patch({ partyContactName: event.target.value })}
        />
      </Field>
      <Field label="Their address">
        <Textarea
          rows={3}
          value={draft.partyAddress}
          maxLength={AGREEMENT_FIELD_CAPS.address}
          data-testid="agreement-party-address"
          onChange={(event) => patch({ partyAddress: event.target.value })}
        />
      </Field>

      {error !== null && (
        <p role="alert" data-testid="agreement-error" className="text-sm text-red-600">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={issue.isPending}>
          Cancel
        </Button>
        <Button type="submit" data-testid="agreement-submit" disabled={issue.isPending}>
          {issue.isPending ? "Rendering..." : "Raise agreement"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
      <span>{label}</span>
      {children}
    </label>
  );
}
