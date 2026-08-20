import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { clsx } from "clsx";
import type { FileMeta, SendMailInput } from "@conduit/shared";
import {
  useContacts,
  useMailAccounts,
  useMailTemplates,
  useMe,
  useSendMail,
  useUploadFile,
} from "../../queries";
import {
  attachmentTarget,
  composeErrorMessage,
  dedupeRecipients,
  htmlIsBlank,
  parseRecipientInput,
  resolveRecipients,
  signatureBlock,
  substitutePlaceholdersHtml,
  templateSubject,
  type ComposerLinks,
  type ComposerRecipient,
  type TemplateContext,
} from "./mail-lib";
import { RichTextEditor, type RichTextHandle } from "./rich-text";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/**
 * Everything a caller can pre-fill. Every field is optional: the inbox opens
 * the composer with nothing (a blank compose), a record page with addresses
 * and links, and a conversation with a threadId and a quoted body (Task 10's
 * reply/reply-all/forward).
 */
export interface ComposerSeed {
  /** Send from this account rather than the first active one. */
  accountId?: string;
  /** Present on a reply: the message joins this thread instead of starting one. */
  threadId?: string;
  subject?: string;
  to?: readonly ComposerRecipient[];
  cc?: readonly ComposerRecipient[];
  /** Pre-filled body -- a forward's quoted original, typically. */
  bodyHtml?: string;
  /**
   * Record links applied to a NEW thread (ignored server-side on a reply,
   * which already has one). Also decides which record an attachment upload is
   * filed against -- see mail-lib's attachmentTarget, and note that a
   * seed with no links at all disables the attach control entirely, so a
   * reply opened from a conversation should pass the THREAD's links.
   */
  links?: ComposerLinks;
  /**
   * Names for template placeholders. Supplied by the opener (a record page
   * knows its own contact/company) rather than fetched here from
   * `links`: the caller already holds them, and an unresolved placeholder is
   * a supported outcome, not a failure.
   */
  context?: Pick<TemplateContext, "contactName" | "companyName">;
}

export interface ComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: ComposerSeed;
}

const NO_TEMPLATE = "none";

/**
 * The compose/reply dialog, mounted by the inbox, the conversation view and
 * every record page's Mail tab with different seeds (Task 10).
 *
 * Controlled from outside (`open`/`onOpenChange`) and stateless itself: all
 * the draft state lives in ComposerForm, which Radix mounts fresh on every
 * open and unmounts on close. That is deliberate -- it is what makes "open
 * the composer with a different seed" work without a single reset effect, and
 * what gives the body editor a clean document each time.
 */
export function Composer({ open, onOpenChange, seed }: ComposerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        {open && <ComposerForm seed={seed} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ComposerForm({ seed, onClose }: { seed?: ComposerSeed; onClose: () => void }) {
  const { data: accounts, isLoading: accountsLoading } = useMailAccounts();
  // {archived:false} explicitly, matching the settings page's own call, so
  // both share one ['email-templates', {archived:false}] cache entry.
  const { data: templates = [] } = useMailTemplates({ archived: false });
  const { data: me } = useMe();
  const send = useSendMail();
  const upload = useUploadFile();
  const editorRef = useRef<RichTextHandle>(null);

  // Only what the user PICKED lives in state; the effective selection is
  // derived. An effect that back-filled the first account instead would flip
  // the Radix select from uncontrolled (undefined) to controlled (a string)
  // on the render after the accounts arrive, which Radix warns about.
  const [accountId, setAccountId] = useState<string | null>(seed?.accountId ?? null);
  const [to, setTo] = useState<ComposerRecipient[]>([...(seed?.to ?? [])]);
  const [cc, setCc] = useState<ComposerRecipient[]>([...(seed?.cc ?? [])]);
  const [bcc, setBcc] = useState<ComposerRecipient[]>([]);
  // The three in-progress drafts live HERE, not inside each RecipientField:
  // handleSubmit has to be able to read what is still sitting in an input at
  // the instant Send is pressed (see resolveRecipients' doc comment for the
  // bug that costs otherwise).
  const [toDraft, setToDraft] = useState("");
  const [ccDraft, setCcDraft] = useState("");
  const [bccDraft, setBccDraft] = useState("");
  const [showCcBcc, setShowCcBcc] = useState((seed?.cc ?? []).length > 0);
  const [subject, setSubject] = useState(seed?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(seed?.bodyHtml ?? "");
  const [attachments, setAttachments] = useState<FileMeta[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  // Bumped every time the editor announces itself (RichTextEditor's onCreate,
  // which TipTap emits from a timeout AFTER the instance is live and skips
  // entirely for an instance that was destroyed first). Everything about the
  // signature hangs off this rather than off the ref being populated.
  const [editorEpoch, setEditorEpoch] = useState(0);
  // Which (editor instance, account) pair has already had a signature.
  const signedFor = useRef<string | null>(null);

  // Own, non-archived, non-error accounts: those are exactly the ones
  // mail-send.ts will accept a send from (owner-only, active, not archived).
  const sendableAccounts = useMemo(
    () => (accounts?.own ?? []).filter((account) => account.archivedAt === null && account.status === "active"),
    [accounts],
  );

  const selectedAccountId = accountId ?? sendableAccounts[0]?.id ?? null;

  /**
   * Signature behaviour, deliberately simple: the selected account's
   * signature is appended ONCE, at the end of the body, for each (editor,
   * account) pair -- the initial auto-selection included. Switching accounts
   * appends the new one rather than trying to find and replace the old block:
   * once the text is in the editor it is ordinary editable content the user
   * may have rewritten, and TipTap's schema will have normalised the markup
   * anyway, so there is nothing reliable left to match on.
   *
   * Keying the guard on the editor EPOCH rather than on the account alone is
   * what makes this robust: an editor that gets rebuilt (a remount, or a
   * TipTap version that recreates its instance) announces itself again, so
   * the fresh, empty document gets the signature instead of silently losing
   * it -- and because the append only ever runs after onCreate, it can never
   * race the editor's own construction.
   */
  useEffect(() => {
    if (editorEpoch === 0 || selectedAccountId === null) return;
    const key = `${editorEpoch}:${selectedAccountId}`;
    if (signedFor.current === key) return;
    signedFor.current = key;
    const signature = sendableAccounts.find((account) => account.id === selectedAccountId)?.signatureHtml;
    if (signature == null || signature === "") return;
    editorRef.current?.appendAtEnd(signatureBlock(signature));
  }, [editorEpoch, selectedAccountId, sendableAccounts]);


  const context: TemplateContext = {
    contactName: seed?.context?.contactName,
    companyName: seed?.context?.companyName,
    userName: me?.fullName ?? me?.username,
  };

  const target = attachmentTarget(seed?.links);

  function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined || target === null) return;
    setLocalError(null);
    upload.mutate(
      { file, ...target },
      {
        onSuccess: (meta: FileMeta) => setAttachments((current) => [...current, meta]),
        onError: (error: unknown) => setLocalError(composeErrorMessage(error)),
      },
    );
  }

  function applyTemplate(templateId: string) {
    const template = templates.find((entry) => entry.id === templateId);
    if (template === undefined) return;
    setSubject((current) =>
      templateSubject(current, template.subject, { isReply: seed?.threadId !== undefined, context }));
    editorRef.current?.insertAtCursor(substitutePlaceholdersHtml(template.bodyHtml, context));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (selectedAccountId === null) {
      setLocalError("Choose an account to send from.");
      return;
    }
    // Committed chips PLUS whatever is still typed, resolved synchronously
    // here -- a recipient the user typed but never separated must be sent,
    // not silently dropped, and one that is not an address must be reported.
    const resolvedTo = resolveRecipients(to, toDraft);
    const resolvedCc = resolveRecipients(cc, ccDraft);
    const resolvedBcc = resolveRecipients(bcc, bccDraft);
    const invalid = [...resolvedTo.invalid, ...resolvedCc.invalid, ...resolvedBcc.invalid];
    if (invalid.length > 0) {
      // Nothing is committed on this path: chipping the half of the line that
      // parsed while the input still shows the whole string the user typed
      // would leave the two disagreeing about what is addressed.
      setLocalError(`Not an email address: ${invalid.join(", ")}`);
      return;
    }
    setTo(resolvedTo.recipients);
    setCc(resolvedCc.recipients);
    setBcc(resolvedBcc.recipients);
    setToDraft("");
    setCcDraft("");
    setBccDraft("");
    if (resolvedTo.recipients.length === 0) {
      setLocalError("Add at least one recipient.");
      return;
    }
    if (htmlIsBlank(bodyHtml)) {
      setLocalError("The message is empty.");
      return;
    }
    setLocalError(null);
    const input: SendMailInput = {
      accountId: selectedAccountId,
      threadId: seed?.threadId,
      to: resolvedTo.recipients,
      cc: resolvedCc.recipients,
      bcc: resolvedBcc.recipients,
      subject,
      bodyHtml,
      attachmentIds: attachments.map((file) => file.id),
      links: seed?.links,
    };
    send.mutate(input, { onSuccess: onClose });
  }

  return (
    <form data-testid="composer" onSubmit={handleSubmit} className="flex flex-col gap-3">
      <DialogTitle>{seed?.threadId === undefined ? "New message" : "Reply"}</DialogTitle>

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        From
        {accountsLoading ? (
          <p className="text-sm text-slate-400">Loading accounts...</p>
        ) : sendableAccounts.length === 0 ? (
          <p className="text-sm text-slate-400">
            No active mail account. Add one in Settings {"\u2192"} Mail accounts.
          </p>
        ) : (
          // Only rendered once there IS an account, so the derived value is a
          // string from this select's very first render -- never undefined.
          <Select value={selectedAccountId ?? undefined} onValueChange={(value) => setAccountId(value)}>
            <SelectTrigger ariaLabel="From" testId="composer-account">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sendableAccounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.label} {"\u00B7"} {account.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </label>

      <RecipientField
        label="To"
        testId="composer-to"
        recipients={to}
        onChange={setTo}
        draft={toDraft}
        onDraftChange={setToDraft}
        onInvalid={setLocalError}
      />

      {showCcBcc ? (
        <>
          <RecipientField
            label="Cc"
            testId="composer-cc"
            recipients={cc}
            onChange={setCc}
            draft={ccDraft}
            onDraftChange={setCcDraft}
            onInvalid={setLocalError}
          />
          <RecipientField
            label="Bcc"
            testId="composer-bcc"
            recipients={bcc}
            onChange={setBcc}
            draft={bccDraft}
            onDraftChange={setBccDraft}
            onInvalid={setLocalError}
          />
        </>
      ) : (
        <Button variant="ghost" className="self-start" onClick={() => setShowCcBcc(true)}>
          Add Cc/Bcc
        </Button>
      )}

      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Subject
        <Input
          data-testid="composer-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>

      {templates.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-600">Template</span>
          <div className="w-64">
            {/* Value stays on the sentinel: picking an entry APPLIES it (the
                subject when composing fresh, the body at the caret) rather
                than putting the composer into a "template mode" it would then
                have to leave. */}
            <Select value={NO_TEMPLATE} onValueChange={applyTemplate}>
              <SelectTrigger ariaLabel="Template" testId="composer-template">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEMPLATE}>Insert a template...</SelectItem>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <RichTextEditor
        ref={editorRef}
        initialHtml={seed?.bodyHtml ?? ""}
        onChange={setBodyHtml}
        onCreate={() => setEditorEpoch((epoch) => epoch + 1)}
        ariaLabel="Message body"
        testId="composer-body"
      />

      <div className="flex flex-wrap items-center gap-2">
        <label
          className={`rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 ${
            target === null ? "cursor-not-allowed opacity-50" : "cursor-pointer"
          }`}
        >
          {upload.isPending ? "Uploading..." : "Attach file"}
          <input type="file" className="hidden" onChange={handleUpload} disabled={target === null || upload.isPending} />
        </label>
        {target === null && (
          <span className="text-xs text-slate-400">
            Attachments need a linked record (compose from a contact, company, deal or project).
          </span>
        )}
        {attachments.map((file) => (
          <span
            key={file.id}
            data-testid={`composer-attachment-${file.id}`}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
          >
            {file.originalName}
            <button
              type="button"
              // "Do not attach", not "Remove": this only drops the file from
              // THIS message. The upload is already a files row on the record
              // it was filed against, and stays on that record's Files rail
              // whether the message is ever sent or not.
              aria-label={`Do not attach ${file.originalName}`}
              className="text-slate-400 hover:text-slate-900"
              onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}
            >
              {"\u00D7"}
            </button>
          </span>
        ))}
      </div>

      {localError !== null && <p role="alert" className="text-sm text-red-600">{localError}</p>}
      {send.isError && <p role="alert" className="text-sm text-red-600">{composeErrorMessage(send.error)}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          type="submit"
          data-testid="composer-send"
          // A typed-but-uncommitted recipient counts: handleSubmit resolves
          // the draft before it decides there is nobody to send to.
          disabled={send.isPending || selectedAccountId === null || (to.length === 0 && toDraft.trim() === "")}
        >
          {send.isPending ? "Sending..." : "Send"}
        </Button>
      </div>
    </form>
  );
}

/**
 * One To/Cc/Bcc line: committed addresses as chips, plus an input that
 * commits on a separator (comma/semicolon/newline), Enter, Tab or blur, and
 * suggests contact addresses as you type.
 *
 * All the parsing lives in mail-lib.ts (and is unit-tested there); this
 * component is only the wiring.
 */
function RecipientField({
  label,
  testId,
  recipients,
  onChange,
  draft,
  onDraftChange,
  onInvalid,
}: {
  label: string;
  testId: string;
  recipients: ComposerRecipient[];
  onChange: (next: ComposerRecipient[]) => void;
  /** Owned by the composer, not this field -- see its useState comment. */
  draft: string;
  onDraftChange: (next: string) => void;
  onInvalid: (message: string | null) => void;
}) {
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  // -1 = nothing highlighted, which is the state the dropdown OPENS in.
  // Unlike the global search (components/search.tsx, whose list is the only
  // thing Enter can act on and which therefore highlights its first row), the
  // typed text here is itself a valid answer -- so Enter commits what was
  // typed until the user has actually arrowed into the list.
  const [highlight, setHighlight] = useState(-1);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(draft), 200);
    return () => clearTimeout(timer);
  }, [draft]);

  const query = debounced.trim();
  const { data: contactsData } = useContacts(query === "" ? { limit: 10 } : { q: query, limit: 10 });

  // Every address of every matching contact is its own suggestion (a contact
  // may have several), minus the ones already on this line.
  const suggestions = useMemo(() => {
    const taken = new Set(recipients.map((entry) => entry.address.toLowerCase()));
    const out: ComposerRecipient[] = [];
    for (const contact of contactsData?.items ?? []) {
      const name = `${contact.firstName} ${contact.lastName ?? ""}`.trim();
      for (const address of contact.emails) {
        if (taken.has(address.toLowerCase())) continue;
        out.push({ address, name: name === "" ? null : name });
      }
    }
    return out.slice(0, 8);
  }, [contactsData, recipients]);

  // A fresh result set always drops the highlight back to "none" -- keyed on
  // the fetched data (not `suggestions`, a new array every render), mirroring
  // components/search.tsx.
  useEffect(() => {
    setHighlight(-1);
  }, [contactsData]);

  function commit(recipient: ComposerRecipient) {
    onChange(dedupeRecipients([...recipients, recipient]));
    onDraftChange("");
    setHighlight(-1);
    setOpen(false);
  }

  function handleChange(value: string) {
    const parsed = parseRecipientInput(value);
    if (parsed.tokens.length > 0) onChange(dedupeRecipients([...recipients, ...parsed.tokens]));
    if (parsed.invalid.length > 0) onInvalid(`Not an email address: ${parsed.invalid.join(", ")}`);
    else if (parsed.tokens.length > 0) onInvalid(null);
    onDraftChange(parsed.remainder);
    setOpen(parsed.remainder.trim() !== "");
  }

  // Enter/Tab/blur all land here. Same resolver the submit path uses, so the
  // two can never disagree about what a half-typed line means.
  function commitDraft(): void {
    if (draft.trim() === "") return;
    const resolved = resolveRecipients(recipients, draft);
    if (resolved.invalid.length > 0) {
      onInvalid(`Not an email address: ${resolved.invalid.join(", ")}`);
      return;
    }
    onChange(resolved.recipients);
    onInvalid(null);
    onDraftChange("");
    setOpen(false);
  }

  const dropdownOpen = open && suggestions.length > 0;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Arrow keys move a single highlight through the suggestions, the same
    // pattern the global search uses; the dropdown is otherwise unreachable
    // without a mouse.
    if (dropdownOpen && event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => Math.min(current + 1, suggestions.length - 1));
      return;
    }
    if (dropdownOpen && event.key === "ArrowUp") {
      event.preventDefault();
      // Back past the top row returns to "none highlighted", so Enter goes
      // back to committing what was typed.
      setHighlight((current) => Math.max(current - 1, -1));
      return;
    }
    if (event.key === "Enter") {
      // Always swallowed: Enter in a recipient field picks or commits, and
      // must never reach the form and send the message half-addressed.
      event.preventDefault();
      const highlighted = dropdownOpen && highlight >= 0 ? suggestions[highlight] : undefined;
      if (highlighted !== undefined) commit(highlighted);
      else commitDraft();
      return;
    }
    if (event.key === "Tab") {
      // Committed, but NOT preventDefault'd -- Tab has to keep moving focus.
      commitDraft();
      return;
    }
    if (event.key === "Backspace" && draft === "" && recipients.length > 0) {
      onChange(recipients.slice(0, -1));
    }
    if (event.key === "Escape") {
      setHighlight(-1);
      setOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      <div className="relative">
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1">
          {recipients.map((recipient) => (
            <span
              key={recipient.address}
              className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
            >
              {recipient.name != null && recipient.name !== "" ? `${recipient.name} <${recipient.address}>` : recipient.address}
              <button
                type="button"
                aria-label={`Remove ${recipient.address}`}
                className="text-slate-400 hover:text-slate-900"
                onClick={() => onChange(recipients.filter((entry) => entry.address !== recipient.address))}
              >
                {"\u00D7"}
              </button>
            </span>
          ))}
          <input
            data-testid={testId}
            aria-label={label}
            className="min-w-[12rem] flex-1 border-0 px-1 py-1 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
            value={draft}
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setOpen(draft.trim() !== "")}
            onBlur={() => {
              // Synchronous, no timer: the suggestion buttons below swallow
              // their own mousedown, so clicking one never blurs this input
              // and there is no race left to defer around.
              commitDraft();
              setOpen(false);
            }}
          />
        </div>
        {dropdownOpen && (
          <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
            {suggestions.map((suggestion, index) => (
              <li key={`${suggestion.name ?? ""}-${suggestion.address}`}>
                <button
                  type="button"
                  data-testid="composer-suggestion"
                  className={clsx(
                    "block w-full px-3 py-2 text-left text-sm",
                    index === highlight ? "bg-slate-100" : "hover:bg-slate-50",
                  )}
                  // Keeps focus in the input: without this the mousedown
                  // blurs it, the dropdown unmounts, and the click lands on
                  // nothing.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => commit(suggestion)}
                >
                  <span className="block text-slate-900">{suggestion.name ?? suggestion.address}</span>
                  {suggestion.name != null && (
                    <span className="block text-xs text-slate-400">{suggestion.address}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
