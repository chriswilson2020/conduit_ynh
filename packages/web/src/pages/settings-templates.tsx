import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { MAX_TEMPLATE_BYTES } from "@conduit/shared";
import type { EmailTemplate } from "@conduit/shared";
import {
  useArchiveMailTemplate,
  useCreateMailTemplate,
  useDocumentTemplate,
  useMailTemplates,
  useSaveDocumentTemplate,
  useUnarchiveMailTemplate,
  useUpdateMailTemplate,
} from "../queries";
import { htmlIsBlank, PLACEHOLDER_KEYS } from "../components/mail/mail-lib";
import { RichTextEditor } from "../components/mail/rich-text";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { CHECKBOX_LABEL } from "../components/ui/touch";

/**
 * Templates are SHARED across users (email_templates has no owner column), so
 * this page is deliberately not scoped to "my" templates the way the mail
 * accounts page is -- everyone sees, edits and archives the same list.
 */
export function SettingsTemplatesPage() {
  const [archived, setArchived] = useState(false);
  const { data: templates = [], isLoading, error } = useMailTemplates({ archived });
  // null = closed; { template: undefined } = new; { template } = edit.
  const [formTarget, setFormTarget] = useState<{ template?: EmailTemplate } | null>(null);

  return (
    <SettingsLayout>
      <div data-testid="template-settings" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Email templates</h2>
          <div className="flex items-center gap-3">
            <label className={CHECKBOX_LABEL}>
              <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />
              Archived
            </label>
            <Button onClick={() => setFormTarget({})}>New template</Button>
          </div>
        </div>

        {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">Could not load templates: {error.message}</p>
        )}
        {!isLoading && templates.length === 0 && (
          <p className="text-sm text-slate-400">
            {archived ? "No archived templates." : "No templates yet."}
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {templates.map((template) => (
            <TemplateRow key={template.id} template={template} onEdit={() => setFormTarget({ template })} />
          ))}
        </ul>
      </div>

      <DocumentTemplateEditor />

      <Dialog
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          {formTarget !== null && (
            <TemplateForm template={formTarget.template} onClose={() => setFormTarget(null)} />
          )}
        </DialogContent>
      </Dialog>
    </SettingsLayout>
  );
}

/**
 * THE MERGE FIELDS, DOCUMENTED ON THE PAGE RATHER THAN IN A WIKI NOBODY OPENS.
 *
 * These are exactly the keys `buildContext` supplies. A field it does not
 * supply is not an error and never throws -- an unknown path renders as an
 * empty string -- which is precisely why the list has to be here: a typo in a
 * template is an invisible blank on a printed page, discovered by a customer.
 */
const ROOT_FIELDS: readonly [string, string][] = [
  ["org.name", "Your organisation's name"],
  ["org.addressLines", "Your address, line breaks kept"],
  ["org.email", "Your email address"],
  ["org.phone", "Your phone number"],
  ["org.website", "Your website"],
  ["org.vatNumber", "Your VAT number"],
  ["org.registrationNumber", "Your registration number"],
  ["org.bankDetails", "Your bank details, line breaks kept"],
  ["org.logoDataUri", "Your logo, as an image source"],
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
];

/** "{{a}}, {{b}} and {{c}}" -- the mail merge fields as a sentence fragment, so the
 * paragraph below can be written from PLACEHOLDER_KEYS rather than beside it. */
function mergeFieldSentence(paths: readonly string[]): string {
  const tokens = paths.map((path) => `{{${path}}}`);
  const last = tokens.at(-1) ?? "";
  return tokens.length < 2 ? last : `${tokens.slice(0, -1).join(", ")} and ${last}`;
}

const LINE_FIELDS: readonly [string, string][] = [
  ["description", "The line's description"],
  ["qty", "Its quantity"],
  ["unitPrice", "Its unit price, formatted"],
  ["taxRate", "Its tax rate, e.g. 21%"],
  ["lineTotal", "Its total, formatted"],
];

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
 *   - A PLAIN TEXTAREA. Not the rich-text editor the email templates use --
 *     that one serialises through a document model and would rewrite the HTML
 *     wholesale on the first keystroke, which is the same defect from a
 *     different direction.
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
function DocumentTemplateEditor() {
  const { data: template, isLoading, error } = useDocumentTemplate("quote");
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
      <h2 className="text-sm font-semibold text-slate-900">Quote template</h2>
      <p className="text-xs text-slate-500">
        The HTML a quote is rendered from. It is saved sanitised, which is what a quote
        will use; there is no preview here, because the PDF is the preview.
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
        aria-label="Quote template body"
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
            save.mutate({ type: "quote", input: { bodyHtml: value } }, { onSuccess: () => setSaved(true) });
          }}
        >
          {pending ? "Saving..." : "Save template"}
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-slate-200 p-4">
        <FieldList title="Fields" fields={ROOT_FIELDS} />
        <FieldList
          title="Inside a line block"
          fields={LINE_FIELDS}
          note={"Wrap a row in {{#lines}} ... {{/lines}} and it repeats once per line item."}
        />
        <p className="text-xs text-slate-400">
          A field nobody supplies renders as nothing rather than failing, so a typo is a
          blank on the page. Wrapping a field in {"{{#path}} ... {{/path}}"} shows that part
          only when the field has a value. A field inside a style block is left as written.
        </p>
      </div>
    </div>
  );
}

function TemplateRow({ template, onEdit }: { template: EmailTemplate; onEdit: () => void }) {
  const archive = useArchiveMailTemplate();
  const unarchive = useUnarchiveMailTemplate();
  const isArchived = template.archivedAt !== null;

  return (
    <li
      data-testid={`email-template-${template.id}`}
      className={`flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-white px-4 py-3 ${
        isArchived ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-slate-900">{template.name}</p>
        <p className="truncate text-xs text-slate-400">
          {template.subject === "" ? "(no subject)" : template.subject}
        </p>
        {(archive.isError || unarchive.isError) && (
          <p role="alert" className="text-xs text-red-600">{(archive.error ?? unarchive.error)?.message}</p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        {!isArchived && <Button variant="outline" onClick={onEdit}>Edit</Button>}
        {isArchived ? (
          <Button variant="outline" disabled={unarchive.isPending} onClick={() => unarchive.mutate(template.id)}>
            Unarchive
          </Button>
        ) : (
          <Button variant="danger" disabled={archive.isPending} onClick={() => archive.mutate(template.id)}>
            Archive
          </Button>
        )}
      </div>
    </li>
  );
}

function TemplateForm({ template, onClose }: { template?: EmailTemplate; onClose: () => void }) {
  const isEdit = template !== undefined;
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(template?.bodyHtml ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const create = useCreateMailTemplate();
  const update = useUpdateMailTemplate();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") {
      setLocalError("A name is required.");
      return;
    }
    // bodyHtml is `.min(1)` server-side, and an untouched editor still
    // serializes to "<p></p>" -- so emptiness is decided on the rendered
    // text, not the string length (see htmlIsBlank).
    if (htmlIsBlank(bodyHtml)) {
      setLocalError("The template body is empty.");
      return;
    }
    setLocalError(null);
    const input = { name: name.trim(), subject, bodyHtml };
    if (template === undefined) create.mutate(input, { onSuccess: onClose });
    else update.mutate({ id: template.id, patch: input }, { onSuccess: onClose });
  }

  const pending = create.isPending || update.isPending;
  const submitError = create.error ?? update.error;

  return (
    <form data-testid="template-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Name
        <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Follow-up" />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Subject
        <Input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="Following up on {{company.name}}"
        />
      </label>

      <div className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Body
        <RichTextEditor
          initialHtml={template?.bodyHtml ?? ""}
          onChange={setBodyHtml}
          ariaLabel="Template body"
          testId="template-body"
        />
        {/* RENDERED FROM THE SUBSTITUTION'S OWN LIST, not typed out beside it. This
            paragraph is the only place anybody will look for the merge fields, and a
            path documented here that the code does not substitute is an unfilled
            placeholder in a sent email -- so it is derived rather than maintained.
            The quote half of this page (ROOT_FIELDS above) cannot do the same: those
            keys live in the API's buildContext, which this bundle cannot import. */}
        <p className="text-xs font-normal text-slate-400">
          {mergeFieldSentence(Object.keys(PLACEHOLDER_KEYS))} are filled in from the
          records as they stand when the template is used; anything else is left as
          written. An unfilled name stays visible, so you can see what is missing.
        </p>
        {/* THE LIMITATION, SAID PLAINLY RATHER THAN DISCOVERED. An empty salutation
            removes itself and one following space, which handles "Dear X Y" -- but
            nothing removes brackets or a label written around it, so
            "({{contact.pronouns}})" on a contact with none prints "()". Fixing that
            needs conditional blocks, which the mail merge language does not have and
            which is a feature rather than a fix (v1.1.0 coordinator ruling; it is on
            the backlog). Documenting it is what turns a surprise into a choice. */}
        <p className="text-xs font-normal text-slate-400">
          An empty salutation or set of pronouns removes itself, and one space after
          it, so <code>{"Dear {{contact.salutation}} {{contact.name}}"}</code> reads
          &quot;Dear Alice&quot; for a contact with no salutation. Any brackets or
          labels you write around one stay put:{" "}
          <code>{"({{contact.pronouns}})"}</code> prints empty brackets when there are
          no pronouns to put in them.
        </p>
      </div>

      {localError !== null && <p role="alert" className="text-sm text-red-600">{localError}</p>}
      {submitError && <p role="alert" className="text-sm text-red-600">{submitError.message}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending}>{pending ? "Saving..." : "Save"}</Button>
      </div>
    </form>
  );
}
