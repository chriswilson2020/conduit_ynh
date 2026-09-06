import { useEffect, useState } from "react";
import { documentTypeSchema, MAX_TEMPLATE_BYTES, type DocumentType } from "@conduit/shared";
import { useDocumentTemplate, useSaveDocumentTemplate } from "../queries";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

/**
 * Settings -> Templates: one editor per document type.
 *
 * It carried the MAIL templates too until v1.2.2, when that feature was removed
 * outright -- Chris: "I don't think we should ever be templating emails, that's
 * messy and ends up with things like dear first name last name emails!" The route
 * keeps its path and its tab label, because the QUOTE template is what anybody
 * actually opens this page for.
 *
 * IT BECAME PLURAL IN PHASE 9, and it had to: `document_templates` has always been
 * keyed by type and the API has always been `/api/document-templates/:type`, so a
 * page hard-coded to "quote" meant shipping a document type whose template only a
 * `curl` could edit -- while the quote's sits behind a button. The list is derived
 * from `documentTypeSchema` and the labels below are a Record over the union, so a
 * type added in Task 3 or 4 is a BUILD error here rather than a tab nobody added.
 */
export function SettingsTemplatesPage() {
  const [type, setType] = useState<DocumentType>("quote");
  return (
    <SettingsLayout title="Templates">
      <div className="flex flex-col gap-3">
        {/*
          `flex-wrap` SINCE THE SIXTH TAB. Six labels -- Quote, Meeting summary,
          Letter, NDA, Mutual NDA, Status report -- are wider than a phone, and
          this strip is not the record rail's: it has no `overflow-x-auto`, so
          without wrapping it would push `main` sideways rather than scrolling
          inside itself. Settings is not in e2e/mobile.spec.ts's 320px overflow
          sweep (that sweeps the contact and deal pages), so this is reasoned
          rather than measured -- and it was already the wrong shape at five
          tabs, which is why the fix is the wrap and not one fewer word.
        */}
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Document type">
          {documentTypeSchema.options.map((option) => (
            <Button
              key={option}
              role="tab"
              aria-selected={option === type}
              variant={option === type ? "default" : "outline"}
              className="px-3 py-1 text-xs"
              data-testid={`document-template-tab-${option}`}
              onClick={() => setType(option)}
            >
              {TEMPLATE_HELP[option].label}
            </Button>
          ))}
        </div>
        {/*
          KEYED BY TYPE, so switching tabs REMOUNTS the editor. Its `bodyHtml` is
          seeded once from the server and then owned locally (see the effect
          below); without the remount, switching would leave the previous type's
          body in the box and the next Save would write it to the wrong row.
        */}
        <DocumentTemplateEditor key={type} type={type} />
      </div>
    </SettingsLayout>
  );
}

/**
 * THE MERGE FIELDS, DOCUMENTED ON THE PAGE RATHER THAN IN A WIKI NOBODY OPENS.
 *
 * These are exactly the keys the type's context builder supplies. A field it does
 * not supply is not an error and never throws -- an unknown path renders as an
 * empty string -- which is precisely why the list has to be here: a typo in a
 * template is an invisible blank on a printed page, discovered by a customer.
 *
 * A `Record` OVER THE UNION rather than a lookup with a fallback, and for
 * `documentTypeFreezes`'s reason exactly: a type added without an entry is a
 * compile error, where a fallback would quietly show a reader the wrong field list
 * -- which is a page printed with blanks on it.
 */
interface TemplateHelp {
  label: string;
  /** What this template is, in the sentence under the heading. */
  blurb: string;
  fields: readonly [string, string][];
  /** The repeated block this type has, if it has one. */
  collection?: { title: string; note: string; fields: readonly [string, string][] };
}

const ORG_FIELDS: readonly [string, string][] = [
  ["org.name", "Your organisation's name"],
  ["org.addressLines", "Your address, line breaks kept"],
  ["org.email", "Your email address"],
  ["org.phone", "Your phone number"],
  ["org.website", "Your website"],
  ["org.vatNumber", "Your VAT number"],
  ["org.registrationNumber", "Your registration number"],
  ["org.bankDetails", "Your bank details, line breaks kept"],
  ["org.logoDataUri", "Your logo, as an image source"],
];

/**
 * **THE WARNING BELONGS HERE AND NOT ON THE PAGE.** The two agreements ship with
 * a working default so that an NDA renders before anybody has opened Settings --
 * that is the same reason every type has a seeded template -- but the wording of
 * an agreement is a legal question and this product is not qualified to answer
 * it. A note printed INSIDE the PDF saying so would be worse than useless: the
 * PDF goes to the counterparty. So the caveat is shown to the one person who can
 * act on it, standing in the editor that lets them.
 */
const AGREEMENT_CAVEAT = " The wording is a plain-language starting point and not"
  + " legal advice; have it reviewed by your own advisers before you send one, and"
  + " edit it here.";

/**
 * The two agreements name the same fields, because they take the same form and
 * differ only in what their templates SAY about it. One list, for the reason
 * ORG_FIELDS is one list: two copies would be two contracts, and the failure of
 * the second to gain a field somebody added to the first is a blank on a signed
 * page.
 */
const AGREEMENT_FIELDS: readonly [string, string][] = [
  ...ORG_FIELDS,
  ["document.number", "The allocated number, e.g. NDA-2026-0001"],
  ["document.issueDate", "The day the agreement was produced"],
  ["document.effectiveDate", "The date the obligations start"],
  ["document.term", "How long they last, e.g. 36 months"],
  ["document.jurisdiction", "The governing law"],
  ["document.partyName", "The other party"],
  ["document.partyContactName", "The individual they act through, or empty"],
  ["document.partyAddress", "Their address, line breaks kept"],
];

const TEMPLATE_HELP: Record<DocumentType, TemplateHelp> = {
  quote: {
    label: "Quote",
    blurb: "The HTML a quote is rendered from.",
    fields: [
      ...ORG_FIELDS,
      ["document.number", "The allocated number, e.g. QUO-2026-0001"],
      ["document.issueDate", "The issue date"],
      ["document.validUntilDate", "The valid-until date, or empty"],
      ["document.recipientName", "Who the quote is for"],
      ["document.recipientContactName", "The named contact, or empty"],
      ["document.recipientSalutation", "How that contact is addressed, or empty"],
      ["document.recipientAddress", "Their address, line breaks kept"],
      ["document.subtotal", "The subtotal, formatted"],
      ["document.tax", "The tax, formatted"],
      ["document.total", "The total, formatted"],
      ["document.notes", "The notes typed on the quote"],
      ["document.terms", "The terms typed on the quote"],
    ],
    collection: {
      title: "Inside a line block",
      note: "Wrap a row in {{#lines}} ... {{/lines}} and it repeats once per line item.",
      fields: [
        ["description", "The line's description"],
        ["qty", "Its quantity"],
        ["unitPrice", "Its unit price, formatted"],
        ["taxRate", "Its tax rate, e.g. 21%"],
        ["lineTotal", "Its total, formatted"],
      ],
    },
  },
  meeting_summary: {
    label: "Meeting summary",
    blurb: "The HTML a meeting summary is rendered from. Everything on it comes from"
      + " the meeting itself; there is no form to fill in.",
    fields: [
      ...ORG_FIELDS,
      ["document.title", "The meeting's title"],
      ["document.meetingWhen", "When it happened, with the time zone named"],
      ["document.duration", "How long it took, or empty"],
      ["document.issueDate", "The day the summary was produced"],
      // NAMED AS THE ONE EXCEPTION, because it is the one field on this page
      // whose value is markup rather than text, and somebody editing the template
      // needs to know it will bring its own paragraphs and lists with it.
      ["document.notes", "The meeting's notes. Rich text: it arrives as formatted HTML, not plain text"],
    ],
    collection: {
      title: "Inside an attendee block",
      note: "Wrap a row in {{#attendees}} ... {{/attendees}} and it repeats once per attendee.",
      fields: [["name", "The attendee's name"]],
    },
  },
  letter: {
    label: "Letter",
    blurb: "The HTML a letter is rendered from. The body is typed per letter; everything"
      + " around it -- the letterhead, the greeting and the sign-off -- is here.",
    fields: [
      ...ORG_FIELDS,
      ["document.issueDate", "The date on the letter"],
      ["document.subject", "The subject line, or empty"],
      ["document.recipientName", "Who the letter is addressed to"],
      ["document.recipientContactName", "The named contact, or empty"],
      ["document.recipientSalutation", "How that contact is addressed, or empty"],
      ["document.recipientAddress", "Their address, line breaks kept"],
      // THE SECOND EXCEPTION ON THIS PAGE, named for the summary's notes' reason:
      // it is one of the two fields in the whole system whose value is markup
      // rather than text, and somebody editing this template needs to know it
      // brings its own paragraphs with it. There is no `{{document.bodyHtml}}` --
      // the merge path is `body`, because a template is not the place to spell an
      // implementation detail.
      ["document.body", "The letter itself. Rich text: it arrives as formatted HTML, not plain text"],
    ],
  },
  nda: {
    label: "NDA",
    blurb: "The HTML a one-way non-disclosure agreement is rendered from."
      + AGREEMENT_CAVEAT,
    fields: AGREEMENT_FIELDS,
  },
  mutual_nda: {
    label: "Mutual NDA",
    blurb: "The HTML a mutual non-disclosure agreement is rendered from. It differs from"
      + " the one-way version only in wording: the obligations bind each party in respect"
      + " of the other." + AGREEMENT_CAVEAT,
    fields: AGREEMENT_FIELDS,
  },
  project_status_report: {
    label: "Status report",
    blurb: "The HTML a project status report is rendered from. Everything on it comes"
      + " from the project, its tasks and their dependencies; there is no form to fill"
      + " in, and it is produced again whenever you want a fresh one.",
    fields: [
      ...ORG_FIELDS,
      ["document.projectName", "The project's name"],
      ["document.projectStatus", "Active or Completed"],
      ["document.company", "The client the project is for, or empty"],
      ["document.owner", "Who owns the project, or empty"],
      ["document.startDate", "The project's start date, or empty"],
      ["document.dueDate", "The project's due date, or empty"],
      ["document.issueDate", "The day the report was produced"],
      // THE SEVEN COUNTS. Listed one by one rather than described as a group,
      // because the field list is what somebody building their own template reads
      // instead of the source -- and two of them are not derivable from the other
      // five. `overdueCount` carries a rule (due strictly before today, and not
      // done) and `undatedCount` carries another (no due date at all), so their
      // descriptions say what they mean rather than what they are called.
      ["document.taskCount", "How many tasks the report lists"],
      ["document.doneCount", "How many are done"],
      ["document.inProgressCount", "How many are in progress"],
      ["document.blockedCount", "How many are blocked"],
      ["document.todoCount", "How many are still to do"],
      ["document.overdueCount", "How many are past their due date and not done"],
      ["document.undatedCount", "How many have no dates at all"],
    ],
    collection: {
      title: "Inside a task block",
      note: "Wrap a row in {{#tasks}} ... {{/tasks}} and it repeats once per task, in the"
        + " order the Gantt draws them. {{#after}} ... {{/after}} inside that block prints"
        + " only for a task that waits on another.",
      fields: [
        ["title", "The task's title"],
        ["status", "To do, In progress, Blocked or Done"],
        ["startDate", "Its start date, or empty"],
        ["dueDate", "Its due date, or empty"],
        ["progress", "Its progress, e.g. 40%, or empty"],
        ["assignee", "Who it is assigned to, or empty"],
        ["after", "The tasks it waits on, comma-separated, or empty"],
      ],
    },
  },
};

function FieldList({ title, fields, note }: {
  title: string;
  fields: readonly [string, string][];
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold uppercase text-slate-500">{title}</p>
      {note !== undefined && <p className="text-xs text-slate-400">{note}</p>}
      <dl className="grid gap-x-4 gap-y-1 md:grid-cols-2">
        {fields.map(([path, what]) => (
          <div key={path} className="flex flex-col">
            <dt className="font-mono text-xs text-slate-700">{`{{${path}}}`}</dt>
            <dd className="text-xs text-slate-400">{what}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * THE DOCUMENT TEMPLATE EDITOR, AND THE ONE PROPERTY IT MUST NOT BREAK.
 *
 * GET then PUT must return the body UNCHANGED -- f(x) = x, not f(f(x)) = f(x).
 * Task 4's review round bought that property expensively: a save used to come
 * back 38 characters shorter with the letterhead's image silently gone, because
 * template-time sanitising judged an unmerged merge token as a URL, dropped the
 * src and then dropped the whole element. It is now byte-identical for the
 * shipped template, and it is EASY TO BREAK FROM THIS SIDE.
 *
 * NO BYTE COUNT HERE ANY MORE. It said "3,616 in and 3,616 out", which was true
 * of the template Phase 7 seeded and stopped being true the moment v1.1.0's
 * migration 0011 amended the recipient line -- measured at 3,715 after it. A
 * figure that a later migration invalidates is a comment that goes stale on
 * somebody else's change, in a file that change never touches; the property is
 * "byte-identical", and that is what the round-trip test asserts. So:
 *
 *   - A PLAIN TEXTAREA. Not the rich-text editor (components/mail/rich-text.tsx,
 *     which the compose body and the signature field use) -- that one serialises
 *     through a document model and would rewrite the HTML wholesale on the first
 *     keystroke, which is the same defect from a different direction.
 *   - NO trim, NO newline normalisation, NO "tidying" of any kind on the way in
 *     or out. What was fetched is what is held in state and what is sent.
 *   - The response body is written straight back into the field, because the
 *     server stores the SANITISED body and that is what a later quote merges.
 *     Showing what was typed instead of what was stored would hide the one
 *     thing this editor needs to make visible.
 *
 * NOT SANITISED, NOT VALIDATED AND NOT PREVIEWED IN THIS BROWSER. A preview
 * would have to render the template's own CSS and images in a page that carries
 * a session, and it would do so WITHOUT the renderer's data:-only fetcher --
 * so a url() the sanitiser had not yet seen would be a live outbound request
 * from the operator's machine. The server sanitises on write and the PDF is the
 * preview.
 */
function DocumentTemplateEditor({ type }: { type: DocumentType }) {
  const help = TEMPLATE_HELP[type];
  const { data: template, isLoading, error } = useDocumentTemplate(type);
  const save = useSaveDocumentTemplate();
  const [bodyHtml, setBodyHtml] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seeded once from the server, then owned here. Re-seeding on every refetch
  // would overwrite an edit in progress.
  useEffect(() => {
    if (template === undefined) return;
    setBodyHtml((current) => (current === null ? template.bodyHtml : current));
  }, [template]);

  // After a save the stored body IS the answer, so the field is replaced by it
  // -- that is how somebody sees the sanitiser having changed something.
  useEffect(() => {
    if (save.isSuccess) setBodyHtml(save.data.bodyHtml);
  }, [save.isSuccess, save.data]);

  const warnings = save.data?.warnings ?? template?.warnings ?? [];
  const pending = save.isPending;
  const value = bodyHtml ?? "";

  return (
    <div data-testid="document-template-settings" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-slate-900">{`${help.label} template`}</h2>
      <p className="text-xs text-slate-500">
        {`${help.blurb} It is saved sanitised, which is what a document will use;`}
        {" there is no preview here, because the PDF is the preview."}
      </p>

      {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">Could not load the template: {error.message}</p>
      )}

      <Textarea
        value={value}
        rows={18}
        spellCheck={false}
        disabled={pending || isLoading}
        aria-label={`${help.label} template body`}
        data-testid="document-template-body"
        onChange={(event) => { setSaved(false); setBodyHtml(event.target.value); }}
        className="font-mono text-xs"
      />
      <p data-testid="document-template-size" className="text-xs text-slate-400">
        {new TextEncoder().encode(value).length} bytes typed. The stored template may be at
        most {MAX_TEMPLATE_BYTES} bytes AFTER sanitising, which can grow what it is given.
      </p>

      {/*
        THE WARNINGS ARE WHAT THE MERGE DOES SILENTLY, and this is the surface
        they were exported for and never had. None of them can throw -- a
        template being edited is half-written by definition -- and none of them
        should be invisible either: a merge field inside a style block is simply
        left where it stands, and a block nobody closed is ignored along with
        its body.
      */}
      {warnings.length > 0 && (
        <ul data-testid="document-template-warnings" className="flex flex-col gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {save.isError && (
        <p role="alert" data-testid="document-template-error" className="text-sm text-red-600">
          {save.error.message}
        </p>
      )}
      {saved && !save.isError && (
        <p data-testid="document-template-saved" className="text-sm text-green-700">Saved.</p>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={pending || template === undefined}
          data-testid="document-template-revert"
          onClick={() => { setSaved(false); setBodyHtml(template?.bodyHtml ?? ""); }}
        >
          Revert
        </Button>
        <Button
          data-testid="document-template-save"
          disabled={pending || value === ""}
          onClick={() => {
            setSaved(false);
            // The value is sent EXACTLY as held: no trim, no normalisation.
            // That is the whole of what keeps GET then PUT byte-identical.
            save.mutate({ type, input: { bodyHtml: value } }, { onSuccess: () => setSaved(true) });
          }}
        >
          {pending ? "Saving..." : "Save template"}
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-slate-200 p-4">
        <FieldList title="Fields" fields={help.fields} />
        {help.collection !== undefined && (
          <FieldList
            title={help.collection.title}
            fields={help.collection.fields}
            note={help.collection.note}
          />
        )}
        <p className="text-xs text-slate-400">
          A field nobody supplies renders as nothing rather than failing, so a typo is a
          blank on the page. Wrapping a field in {"{{#path}} ... {{/path}}"} shows that part
          only when the field has a value. A field inside a style block is left as written.
        </p>
      </div>
    </div>
  );
}
