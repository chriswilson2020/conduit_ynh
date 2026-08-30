import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, Ref, RefObject } from "react";
import { clsx } from "clsx";
import type { FileMeta, MailAttachment, SendMailInput } from "@conduit/shared";
import { userLabel } from "../../lib";
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
  composerInitialFocus,
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
import type { DialogReturnFocus } from "../ui/dialog-focus";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { CHIP_REMOVE_TOUCH } from "../ui/touch";

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
   * A forward's re-attached originals (Phase 4.3): the source message's
   * stored attachments, listed as removable chips and sent by id as
   * forwardAttachmentIds -- the API streams them onto the outgoing mail
   * from the blobs it already holds, so nothing is re-uploaded. Distinct
   * from the upload flow because the ids name a different table (see the
   * shared sendMailInputSchema's own comments).
   */
  forwardAttachments?: readonly MailAttachment[];
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
  context?: Pick<
    TemplateContext, "contactName" | "contactSalutation" | "contactPronouns" | "companyName"
  >;
}

export interface ComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed?: ComposerSeed;
  /**
   * Where the caret goes when this closes. REQUIRED, and owned by whatever
   * mounts the composer, because the capture has to happen in the handler of
   * the control that opened it -- the inbox's Compose, a record's Mail tab, a
   * conversation's Reply or Forward -- and that handler is not this component's.
   * Required so that a new mount site is a type error rather than a silent
   * landing on `<main>`. See components/ui/dialog-focus.ts.
   */
  returnFocus: DialogReturnFocus;
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
export function Composer({ open, onOpenChange, seed, returnFocus }: ComposerProps) {
  const form = useRef<ComposerFocusHandle>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-3xl overflow-y-auto"
        /**
         * OPENING FOCUS, DECLINED FROM RADIX AND PLACED BY HAND -- which is
         * exactly what ui/dialog.tsx's own hazard note prescribes for a dialog
         * that cannot live with "the first tabbable descendant".
         *
         * MEASURED, BEFORE THIS EXISTED, AND IT WAS THREE DIFFERENT WRONG
         * ELEMENTS RATHER THAN ONE. At 390 the md:hidden Close is the first
         * tabbable child of every dialog, so a blank compose, a reply and a
         * forward all opened on "Close, button" -- the control that throws the
         * draft away. At 1280 that control is display:none and the answer
         * depended on the mailbox: with a sendable account it was the From
         * combobox (a Radix trigger, where letter keys are TYPEAHEAD -- typing
         * a recipient there silently switches which account sends), and with
         * none it was the To field's first CHIP REMOVE BUTTON on any seed that
         * arrives with a recipient, so a reply opened focused on "Remove
         * alice@example.com". Only a blank compose and a forward at 1280 with
         * no account were already right, and only by accident of DOM order.
         *
         * preventDefault() IS REQUIRED, AND NOT FOR THE REASON THIS COMMENT
         * FIRST GAVE. It claimed an autoFocus would be overwritten. It would
         * not: @radix-ui/react-focus-scope gates its whole mount block on
         * `if (!container.contains(document.activeElement))` (dist/index.mjs:80),
         * so focus already inside the content means the AUTOFOCUS_ON_MOUNT
         * event is never even dispatched and focusFirst never runs. That is
         * what ui/dialog.tsx:189-192 has said correctly all along (it was
         * 175-178 until v1.2.0 put a block above it in that file), and a
         * reviewer measured it: a conditional autoFocus on the To input lands
         * correctly with no onOpenAutoFocus at all, chip and combobox ahead of
         * it or not.
         *
         * The real reason is that focus is placed INSIDE this handler, which
         * runs during the dispatch -- after that gate has already been
         * evaluated and passed, since the caret is still on the opener. Radix
         * then runs focusFirst unless the event is prevented, so every one of
         * the three targets would be overwritten. The body case could not use
         * autoFocus in any event: its editor does not exist yet, and the
         * element focus is parked on meanwhile is the Content container, which
         * is not a tabbable descendant and would lose to focusFirst outright.
         * Three targets, one mechanism, and the one that cannot use the
         * simpler tool decides for all of them.
         */
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          // Radix dispatches this ON the Content element, so currentTarget is
          // that element; the cast is only because the DOM types it as the
          // EventTarget any listener could have been attached to.
          const container = event.currentTarget as HTMLElement;
          const form_ = form.current;
          if (form_ === null) {
            // NOT REACHABLE TODAY -- the handle is set in a layout effect and
            // all three targets render unconditionally -- and written anyway
            // because of how bad the alternative is. preventDefault() has just
            // disabled BOTH of Radix's fallbacks (focusFirst and its own
            // `focus(container)` when that finds nothing), so returning here
            // would leave the caret on the opener, OUTSIDE the portal, with
            // the trap unable to reclaim it: its focusin handler recovers by
            // focusing lastFocusedElementRef, which is still null because
            // nothing inside has ever held focus (focus-scope dist/index.mjs:44).
            // A modal nobody can Tab out of, opened with focus behind it, is
            // the worst thing an accessibility fix can leave behind.
            container.focus();
            return;
          }
          form_.focusInitial(container);
        }}
        /**
         * CLOSING FOCUS, A DIFFERENT PROBLEM FROM THE OPENING FOCUS ABOVE and
         * measured landing on `<body>` at both widths. This composer has no
         * `<DialogTrigger>` -- it is opened from the inbox's Compose, a
         * record's Mail tab, and a conversation's Reply and Forward -- so
         * Radix's own restore has nothing to restore to. The opener records
         * itself and hands the object in; components/ui/dialog-focus.ts carries
         * the mechanism and the two designs that tried to avoid the plumbing.
         */
        onCloseAutoFocus={returnFocus.restore}
      >
        {open && <ComposerForm ref={form} seed={seed} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

/** What Composer's onOpenAutoFocus reaches into the form for. */
interface ComposerFocusHandle {
  /**
   * Puts the caret where composerInitialFocus says it belongs. `container` is
   * the dialog's own Content element, which is where focus is PARKED while the
   * body editor is still being built -- see the pending-body-focus effect.
   */
  focusInitial(container: HTMLElement): void;
}

function ComposerForm({ seed, onClose, ref }: {
  seed?: ComposerSeed;
  onClose: () => void;
  ref?: Ref<ComposerFocusHandle>;
}) {
  const { data: accounts, isLoading: accountsLoading } = useMailAccounts();
  // {archived:false} explicitly, matching the settings page's own call, so
  // both share one ['email-templates', {archived:false}] cache entry.
  const { data: templates = [] } = useMailTemplates({ archived: false });
  const { data: me } = useMe();
  const send = useSendMail();
  const upload = useUploadFile();
  const editorRef = useRef<RichTextHandle>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  // Read once, from the seed this form was mounted with: which field the caret
  // belongs in cannot change while the composer is open, and a user who has
  // moved on to another field must never be pulled back by a late render.
  const focusTarget = useRef(composerInitialFocus(seed)).current;
  // Set when the caret belongs in the body and the editor is not built yet,
  // cleared by whoever places it. See the effect below.
  const bodyFocusPending = useRef(false);

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
  // The forward's re-attached originals, seeded whole and removable one by
  // one -- dropping one only leaves it off THIS message, exactly like the
  // upload chips (the original stays on its own message regardless).
  const [forwarded, setForwarded] = useState<readonly MailAttachment[]>(seed?.forwardAttachments ?? []);
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

  /**
   * THE BODY IS THE ONE TARGET THAT CANNOT BE FOCUSED WHEN THE DIALOG OPENS,
   * because it does not exist yet: TipTap builds its editor asynchronously and
   * announces itself through onCreate, which is a whole tick after Radix has
   * fired onOpenAutoFocus. So focusInitial parks focus on the dialog's Content
   * element -- inside the focus trap, which is the part that matters -- and
   * leaves a flag for this effect to drain on the epoch the signature already
   * hangs off. Nothing here reads editorRef being populated; a ref that is
   * filled before the ProseMirror view has attached would take a focus() that
   * does nothing at all. MEASURED at 1280 over five opens of a reply, IN A
   * FOREGROUND TAB: the caret sits on the Content element for 38-65ms and then
   * lands in the body, every time. That is the whole of what the number
   * covers. TipTap sets the ProseMirror selection synchronously but defers the
   * DOM focus into a requestAnimationFrame (@tiptap/core dist/index.js:653),
   * which a backgrounded tab does not run -- so in a hidden tab the caret does
   * not reach the body until the tab is shown, however long that is. (Safari,
   * iOS and Android take an extra synchronous view.dom.focus() four lines
   * above and do not wait; Chromium, which is what the suite runs, does.) It
   * heals itself on the next frame and predates this change; the figure is a
   * foreground measurement and nothing more. It is also why the e2e assertion
   * has to be an auto-waiting toBeFocused rather than a one-shot read of
   * document.activeElement.
   *
   * DECLARED AFTER THE SIGNATURE EFFECT ON PURPOSE, so on the epoch that
   * carries both, the signature is appended and THEN the caret is placed.
   * THEY DID FIGHT, AND THE FIRST VERSION OF THIS COMMENT SAID THEY COULD NOT.
   * appendAtEnd's own comment claims it does not move the caret; it moved the
   * SELECTION, because TipTap's insertContentAt updates it by default, and a
   * reply typed into the instant it opened put "TOPLINE" inside the signature
   * as "-- Vriendelijke groet, s302227TOPLINE". updateSelection:false on the
   * append settles it; rich-text.tsx's focus() carries a deliberately
   * redundant "start" beside it, and says so.
   *
   * AND THE ORDERING ONLY HOLDS ON A WARM ACCOUNTS CACHE, which is worth
   * naming because a bug recorded in the backlog will change it: the signature
   * effect returns early while sendableAccounts is still empty, so on a cold
   * cache the append lands on a LATER pass, after the caret. That is the case
   * updateSelection:false covers and the reason it is not optional.
   */
  useEffect(() => {
    if (editorEpoch === 0 || !bodyFocusPending.current) return;
    const editor = editorRef.current;
    // The flag is spent only once there is something to spend it ON. Clearing
    // it first would drop the caret on the floor for an epoch that arrived
    // without a populated ref, with no later pass able to notice. Cleared
    // BEFORE the focus call rather than after, so an editor that announces
    // itself twice (a remount) cannot pull the caret back out of a field the
    // user has since moved to.
    if (editor === null) return;
    bodyFocusPending.current = false;
    editor.focus();
  }, [editorEpoch]);

  useImperativeHandle(ref, () => ({
    focusInitial(container: HTMLElement) {
      // EVERY BRANCH ENDS WITH FOCUS INSIDE THE CONTENT, including the ones
      // that cannot happen. Composer's handler has already declined Radix's
      // autofocus AND the container fallback it runs when focusFirst finds
      // nothing, so a branch that focuses nothing leaves the caret on the
      // opener, outside the portal, where the trap cannot reclaim it. None of
      // these refs is null today -- all three fields render unconditionally --
      // which is exactly the kind of "today" that stops being true quietly.
      if (focusTarget === "to") {
        (toRef.current ?? container).focus();
        return;
      }
      if (focusTarget === "subject") {
        (subjectRef.current ?? container).focus();
        return;
      }
      bodyFocusPending.current = true;
      // Not left on the opener's button: Radix's autofocus has just been
      // declined, and focus outside a modal surface is focus the trap has no
      // reason to intercept -- a Tab in this window would walk the page
      // BEHIND the dialog. Content carries tabIndex={-1} for exactly this.
      container.focus();
    },
  }), [focusTarget]);

  const context: TemplateContext = {
    contactName: seed?.context?.contactName,
    // Live off the contact record the opener is holding, not stored anywhere: mail
    // is composed and sent in the moment. See TemplateContext.
    contactSalutation: seed?.context?.contactSalutation,
    contactPronouns: seed?.context?.contactPronouns,
    companyName: seed?.context?.companyName,
    userName: userLabel(me, undefined),
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
      forwardAttachmentIds: forwarded.map((attachment) => attachment.id),
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
        inputRef={toRef}
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
          ref={subjectRef}
          data-testid="composer-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
      </label>

      {templates.length > 0 && (
        <div className="flex items-center gap-2 max-md:flex-wrap">
          <span className="text-xs font-medium text-slate-600">Template</span>
          {/* The select takes its own line below the breakpoint; 16rem beside
              the label is wider than a phone's content box. */}
          <div className="w-64 max-md:w-full">
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
        {forwarded.map((attachment) => (
          <span
            key={attachment.id}
            data-testid={`composer-forward-attachment-${attachment.id}`}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700"
          >
            {attachment.filename}
            <button
              type="button"
              // Same wording rule as the upload chips below: dropping the
              // chip only leaves the file off THIS message -- the original
              // keeps its own attachment either way.
              aria-label={`Do not attach ${attachment.filename}`}
              className={`text-slate-400 hover:text-slate-900 ${CHIP_REMOVE_TOUCH}`}
              onClick={() => setForwarded((current) => current.filter((entry) => entry.id !== attachment.id))}
            >
              {"\u00D7"}
            </button>
          </span>
        ))}
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
              className={`text-slate-400 hover:text-slate-900 ${CHIP_REMOVE_TOUCH}`}
              onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== file.id))}
            >
              {"\u00D7"}
            </button>
          </span>
        ))}
        {/* AFTER the chips, deliberately: the sentence explains the greyed
            UPLOAD control, and a forward's re-attached chips work fine
            without a linked record -- rendered directly above working
            chips it read as contradicting them. */}
        {target === null && (
          <span className="text-xs text-slate-400">
            Attachments need a linked record (compose from a contact, company, deal or project).
          </span>
        )}
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
  inputRef,
  recipients,
  onChange,
  draft,
  onDraftChange,
  onInvalid,
}: {
  label: string;
  testId: string;
  /**
   * The typing input, exposed for the ONE line that needs to reach it from
   * outside: the composer's opening focus. Chips come and go around it, so
   * the composer cannot get there by querying its own DOM -- and the first
   * tabbable element of this field is a chip's REMOVE button whenever the
   * seed arrives with a recipient, which is precisely the wrong answer.
   */
  inputRef?: RefObject<HTMLInputElement | null>;
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
                className={`text-slate-400 hover:text-slate-900 ${CHIP_REMOVE_TOUCH}`}
                onClick={() => onChange(recipients.filter((entry) => entry.address !== recipient.address))}
              >
                {"\u00D7"}
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
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
                    // THE 44px FLOOR, and the finding that named this row got
                    // the number from the classes rather than from the page.
                    // Measured at 390x664: a suggestion for a real contact is
                    // 52px, because `name` is never null (firstName is min(1))
                    // so the address always renders as a second line. 36px is
                    // the ONE-LINE shape -- reachable, since min(1) admits a
                    // whitespace-only first name, which trims to "" and drops
                    // the name line. The floor covers that shape and leaves the
                    // 52px one exactly as it was; the flex column is what keeps
                    // the label centred in a box the floor has grown, the same
                    // pairing ui/select.tsx's SelectItem documents.
                    "max-md:flex max-md:min-h-11 max-md:flex-col max-md:justify-center",
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
