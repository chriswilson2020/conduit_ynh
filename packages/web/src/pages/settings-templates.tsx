import { useEffect, useState } from "react";
import { MAX_TEMPLATE_BYTES } from "@conduit/shared";
import { useDocumentTemplate, useSaveDocumentTemplate } from "../queries";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";

/**
 * Settings -> Templates: the quote template, and nothing else.
 *
 * It carried the MAIL templates too until v1.2.2, when that feature was removed
 * outright -- Chris: "I don't think we should ever be templating emails, that's
 * messy and ends up with things like dear first name last name emails!" The route
 * keeps its path and its tab label, because the QUOTE template is what anybody
 * actually opens this page for.
 */
export function SettingsTemplatesPage() {
  return (
    <SettingsLayout title="Templates">
      <DocumentTemplateEditor />
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
