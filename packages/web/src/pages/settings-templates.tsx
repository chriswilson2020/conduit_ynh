import { useState } from "react";
import type { FormEvent } from "react";
import type { EmailTemplate } from "@conduit/shared";
import {
  useArchiveMailTemplate,
  useCreateMailTemplate,
  useMailTemplates,
  useUnarchiveMailTemplate,
  useUpdateMailTemplate,
} from "../queries";
import { htmlIsBlank } from "../components/mail/mail-lib";
import { RichTextEditor } from "../components/mail/rich-text";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";

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
            <label className="flex items-center gap-2 text-sm text-slate-600">
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
        <p className="text-xs font-normal text-slate-400">
          {"{{contact.name}}"}, {"{{company.name}}"} and {"{{user.name}}"} are filled in when the
          template is used; anything else is left as written.
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
