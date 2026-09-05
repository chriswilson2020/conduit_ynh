import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useSearch } from "@tanstack/react-router";
import { clsx } from "clsx";
import { mailOAuthProviderOf } from "@conduit/shared";
import type {
  MailAccountFolder, MailAccountTestResult, MailAccountWithSyncStats, MailOAuthProvider,
  MailSecurity,
} from "@conduit/shared";
import { relativeTime } from "../lib";
import {
  useArchiveMailAccount,
  useCreateFolder,
  useCreateMailAccount,
  useDeleteFolder,
  useMailAccounts,
  useMailFolders,
  useMailOAuthProviders,
  useMe,
  useRenameFolder,
  useSetFolderSync,
  useStartMailOAuthSignin,
  useTestMailAccount,
  useUnarchiveMailAccount,
  useUpdateMailAccount,
} from "../queries";
import {
  friendlyMailError, htmlIsBlank, moveTargetPatch, newestDiscovery,
} from "../components/mail/mail-lib";
import {
  accountReauthMessage,
  accountStatusLabel,
  buildCreateInput,
  buildOAuthSigninInput,
  buildOAuthUpdatePatch,
  buildReauthorizeInput,
  buildTestInput,
  buildUpdatePatch,
  dovecotPreset,
  folderCommandReasons,
  folderDeleteBlocked,
  folderDeleteWarning,
  folderRenameBlocked,
  initialFormState,
  initialOAuthFormState,
  oauthSetupHint,
  providerLabel,
  providerSigninCaveat,
  signedInWith,
  signinBanner,
  validateForm,
  validateOAuthForm,
  type AccountFormState,
  type MailSigninMethod,
  type OAuthFormState,
} from "./settings-mail-lib";
import { RichTextEditor } from "../components/mail/rich-text";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { useDialogReturnFocus } from "../components/ui/dialog-focus";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { CHECKBOX_LABEL } from "../components/ui/touch";

/**
 * Poll interval for GET /api/mail/accounts, and the ONLY place in the app
 * that sets one.
 *
 * This page owns freshness for the sync counters it renders (the freshness
 * contract in routes/mail.ts's handler doc comment): `syncStats` are
 * in-process counters read at fetch time, and no write publishes a hint when
 * they move -- the ["mail-accounts"] SSE hint fires on account mutations and
 * status flips, which is a different, much rarer event. Every other consumer
 * of useMailAccounts treats it as an SSE-invalidated cache of the account
 * rows and polls nothing.
 */
const ACCOUNT_POLL_MS = 10_000;

export function SettingsMailPage() {
  const { data, isLoading, error } = useMailAccounts({ refetchInterval: ACCOUNT_POLL_MS });
  // null = closed; { account: undefined } = add; { account } = edit. One
  // dialog serves both, and Radix unmounts its content on close, so the form
  // inside starts from a clean state on every open.
  const [formTarget, setFormTarget] = useState<{ account?: MailAccountWithSyncStats } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // One dialog, two openers per account plus Add account at the top, so the
  // control to give the caret back to is whichever one was used -- captured on
  // open rather than held here. See components/ui/dialog-focus.ts.
  const returnFocus = useDialogReturnFocus();

  // Phase 8: what the OAuth callback redirected back with. Read from the URL
  // rather than held in state because the callback is a full page navigation --
  // this component is mounting for the first time when it arrives, so there is
  // no state for it to have survived in.
  const search = useSearch({ from: "/settings/mail" });
  // Fetched HERE as well as in the dialog, so the answer is already cached when
  // the dialog opens and the add-account form never has to render a spinner
  // before it can ask its first question. One query key, so this is one request
  // per session (staleTime: Infinity -- it is deployment configuration).
  const oauthConfig = useMailOAuthProviders();
  // The redirect URI reaches the banner for the one failure it can explain --
  // see signinBanner. Undefined while the query is in flight, which is the
  // right value to pass: the banner then says what it always said, and the
  // extra sentence appears on the re-render rather than never.
  const banner = signinBanner(search, oauthConfig.data?.redirectUri);

  const own = data?.own ?? [];
  const active = own.filter((account) => account.archivedAt === null);
  const archived = own.filter((account) => account.archivedAt !== null);
  const others = data?.others ?? [];

  return (
    <SettingsLayout title="Mail accounts">
      <div data-testid="mail-settings" className="flex flex-col gap-4">
        {banner !== null && (
          <p
            data-testid="oauth-banner"
            // role="status" for the success and role="alert" for the failure:
            // one is an outcome the operator asked for and the other interrupts
            // what they were about to do next.
            role={banner.tone === "ok" ? "status" : "alert"}
            className={clsx(
              "rounded-md border px-3 py-2 text-sm",
              banner.tone === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800",
            )}
          >
            {banner.text}
          </p>
        )}

        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Your mail accounts</h2>
          <Button
            onClick={(event) => {
              returnFocus.capture(event.currentTarget);
              setFormTarget({});
            }}
          >
            Add account
          </Button>
        </div>

        {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            Could not load mail accounts: {error.message}
          </p>
        )}

        {!isLoading && active.length === 0 && (
          <p className="text-sm text-slate-400">
            No mail account yet. Add one to start syncing your inbox.
          </p>
        )}

        {active.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            onEdit={(trigger) => { returnFocus.capture(trigger); setFormTarget({ account }); }}
          />
        ))}

        {archived.length > 0 && (
          <section className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowArchived((current) => !current)}
              className="self-start text-sm font-medium text-slate-500 hover:text-slate-900"
            >
              {showArchived ? "Hide" : "Show"} archived accounts ({archived.length})
            </button>
            {/* Settings is the one place archived accounts must stay
                reachable: archiving stops the sync but keeps the messages,
                and unarchiving is the only way back (re-adding the mailbox
                would re-ingest every thread under a new account id). */}
            {showArchived && archived.map((account) => (
              <AccountCard key={account.id} account={account} onEdit={(trigger) => { returnFocus.capture(trigger); setFormTarget({ account }); }} />
            ))}
          </section>
        )}

        {others.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="mt-4 text-sm font-semibold text-slate-900">Other users' mailboxes</h2>
            {/* Phase 4.2 rewrote this line: the pre-4.2 copy ("their threads
                are visible to you") states the INVERSE of private-by-default.
                This list enumerates every synced mailbox regardless of
                visibility -- that is its job (reply-all must steer clear of
                all of them, and account chips need labels) -- so the sentence
                must carry the sharing line, not promise visibility. */}
            <p className="text-xs text-slate-400">
              Listed so reply detection covers every synced mailbox. Their conversations are
              visible to you only if the owner shares the mailbox or links a thread to a deal
              or project; their settings are never visible.
            </p>
            <ul className="rounded-md border border-slate-200 bg-white">
              {others.map((account) => (
                <li key={account.id} className="border-b border-slate-100 px-4 py-2 text-sm text-slate-600 last:border-b-0">
                  {account.label} {"\u00B7"} {account.email}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <Dialog
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
      >
        <DialogContent
          className="max-h-[85vh] max-w-2xl overflow-y-auto"
          onCloseAutoFocus={returnFocus.restore}
        >
          {formTarget !== null && (
            <AccountForm account={formTarget.account} onClose={() => setFormTarget(null)} />
          )}
        </DialogContent>
      </Dialog>
    </SettingsLayout>
  );
}

function AccountCard({
  account,
  onEdit,
}: {
  account: MailAccountWithSyncStats;
  onEdit: (trigger: HTMLElement) => void;
}) {
  const test = useTestMailAccount();
  const archive = useArchiveMailAccount();
  const unarchive = useUnarchiveMailAccount();
  const [showSignature, setShowSignature] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const isArchived = account.archivedAt !== null;
  const reauthMessage = accountReauthMessage(account.status, account.authMethod);
  const provider = mailOAuthProviderOf(account.authMethod);

  return (
    <section
      data-testid={`mail-account-${account.id}`}
      className={`rounded-md border border-slate-200 bg-white p-4 ${isArchived ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{account.label}</span>
            <StatusBadge status={account.status} archived={isArchived} />
          </div>
          <p className="text-sm text-slate-600">{account.email}</p>
          {/* Phase 8: rendered from auth_method, which is in the clear -- the
              whole reason that column exists is that a settings row must not
              have to touch mail.key to say this (api: db/schema.ts). */}
          {signedInWith(account.authMethod) !== null && (
            <p data-testid={`signed-in-with-${account.id}`} className="mt-1 text-xs text-slate-500">
              {signedInWith(account.authMethod)}
            </p>
          )}
          <p className="mt-1 text-xs text-slate-400">
            IMAP {account.imapHost}:{account.imapPort} ({account.imapSecurity})
            {" \u00B7 "}
            SMTP {account.smtpHost}:{account.smtpPort} ({account.smtpSecurity})
            {" \u00B7 "}
            {account.username}
          </p>
          <p className="text-xs text-slate-400">
            Sent folder {account.sentFolder}
            {" \u00B7 "}
            {account.lastSyncedAt === null ? "never synced" : `synced ${relativeTime(account.lastSyncedAt)}`}
          </p>
          {account.syncStats != null && (
            <p className="text-xs text-slate-400">
              {account.syncStats.passes} passes
              {" \u00B7 "}
              {account.syncStats.ingested} ingested
              {" \u00B7 "}
              {account.syncStats.poisonSkips} skipped
              {" \u00B7 "}
              {account.syncStats.idleWakes} idle wakes
              {account.syncStats.attempt > 0 && ` \u00B7 retrying (attempt ${account.syncStats.attempt})`}
              {account.syncStats.stopped && " \u00B7 stopped"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!isArchived && (
            <>
              <Button variant="outline" onClick={(event) => onEdit(event.currentTarget)}>Edit</Button>
              {provider !== null && <ReauthorizeButton accountId={account.id} provider={provider} />}
              <Button
                variant="outline"
                disabled={test.isPending}
                onClick={() => test.mutate({ accountId: account.id })}
              >
                {test.isPending ? "Testing..." : "Test connection"}
              </Button>
              <Button variant="outline" onClick={() => setShowSignature((current) => !current)}>
                Signature
              </Button>
              <Button
                variant="outline"
                data-testid={`folders-toggle-${account.id}`}
                onClick={() => setShowFolders((current) => !current)}
              >
                Folders
              </Button>
              <Button
                variant="danger"
                disabled={archive.isPending}
                onClick={() => {
                  if (!window.confirm(`Archive ${account.label}? Syncing stops; messages stay.`)) return;
                  archive.mutate(account.id);
                }}
              >
                Archive
              </Button>
            </>
          )}
          {isArchived && (
            <Button
              variant="outline"
              disabled={unarchive.isPending}
              onClick={() => unarchive.mutate(account.id)}
            >
              Unarchive
            </Button>
          )}
        </div>
      </div>

      {/* The two are mutually exclusive by construction (one status column), and
          they are two elements rather than one because they say different KINDS
          of thing: an error is the server's report, and this is an instruction
          to the person reading it. */}
      {reauthMessage !== null && (
        <p role="alert" className="mt-2 text-sm text-amber-700">{reauthMessage}</p>
      )}
      {account.status === "error" && account.lastError !== null && (
        <p role="alert" className="mt-2 text-sm text-red-600">{friendlyMailError(account.lastError)}</p>
      )}
      {(archive.isError || unarchive.isError) && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {(archive.error ?? unarchive.error)?.message}
        </p>
      )}
      {test.isError && <p role="alert" className="mt-2 text-sm text-red-600">{test.error.message}</p>}
      {test.data !== undefined && <TestResult result={test.data} />}

      {/* NOT on an archived card: the account PATCH refuses archived rows
          outright (mail-accounts.ts's ArchivedError), so a toggle here would
          be a control that can only fail. An archived shared mailbox keeps
          its visibility until it is unarchived -- flip it there. */}
      {!isArchived && <VisibilitySection account={account} />}
      {showSignature && !isArchived && <SignatureEditor account={account} />}
      {/* Folders stay editable on an ARCHIVED account too: its rows survive
          (archive-not-delete), curating them while the mailbox is put away is
          reasonable, and the API refuses none of it -- enabling one simply
          finds no sync loop to ask for a pass. */}
      {showFolders && <FolderPicker account={account} />}
    </section>
  );
}

/**
 * Send the operator back to the provider for a fresh grant (Phase 8 Task 3).
 *
 * ON EVERY OAUTH ACCOUNT, not only on one whose grant has lapsed. A grant can
 * be revoked at the provider without this install hearing about it until the
 * next pass, and the operator who has just fixed something at Azure should not
 * have to wait for a badge before they can act. The lapsed case is the one that
 * NEEDS it; the rest is a control that is where it will be looked for.
 *
 * IT IS NOT LABELLED "Sign in again", AND THAT IS TASK 2'S GUARD CATCHING THIS
 * BUTTON. It was, at first. Those three words are the badge's own text for
 * status='auth_required' (accountStatusLabel), and e2e/mail-reauth.spec.ts has
 * a case whose whole purpose is that they must NOT appear on a row whose
 * failure is an ordinary one -- because an operator told to re-authorise over a
 * mail server that is rebooting has been sent away from Test connection, which
 * is the control that would actually help. A button carrying the badge's phrase
 * on every provider row put those words on exactly the card that test forbids
 * them on, and it failed. Naming the PROVIDER instead says what the button does
 * without borrowing a sentence that means something else, and it matches the
 * add-account form's "Continue with Microsoft". That test now guards the label:
 * renaming it back turns the suite red again.
 *
 * THE NAVIGATION IS A FULL PAGE LOAD, deliberately: the consent screen is a
 * third party's page and the callback comes back as a top-level request
 * carrying SSOwat's identity, which is what the server's state check compares
 * against. An iframe or a popup would work at both providers and would make
 * that identity's presence a property of the browser's cookie policy.
 */
function ReauthorizeButton({ accountId, provider }: { accountId: string; provider: MailOAuthProvider }) {
  const signin = useStartMailOAuthSignin();
  return (
    <>
      <Button
        variant="outline"
        data-testid={`reauthorize-${accountId}`}
        disabled={signin.isPending}
        onClick={() => {
          signin.mutate(buildReauthorizeInput(accountId, provider), {
            onSuccess: ({ authorizeUrl }) => { window.location.assign(authorizeUrl); },
          });
        }}
      >
        {signin.isPending ? "Opening..." : `Sign in with ${providerLabel(provider)}`}
      </Button>
      {signin.isError && (
        <p role="alert" className="w-full text-sm text-red-600">{signin.error.message}</p>
      )}
    </>
  );
}

/**
 * The per-account Private / Shared toggle (Phase 4.2). Owner-only like every
 * account setting -- it renders on the owner's own card, and the PATCH it
 * sends 404s for anyone else.
 *
 * A PLAIN mutation, deliberately not an optimistic one: the switch shows the
 * account row's own value and waits for the PATCH + refetch to move it. An
 * optimistic flip would need an echo to confirm or roll back, and a
 * same-value submit publishes NO SSE frame at all (updateAccount's no-op
 * short-circuit) -- an optimistic UI waiting on that echo would hang on
 * exactly the gesture that changes nothing. The useUpdateMailAccount hook's
 * own ["mail-accounts"] invalidation is what moves the switch, a fetch
 * round-trip after the click.
 */
function VisibilitySection({ account }: { account: MailAccountWithSyncStats }) {
  const update = useUpdateMailAccount();
  const shared = account.visibility === "shared";
  const copyId = `visibility-copy-${account.id}`;

  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-slate-100 pt-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase text-slate-500">Visibility</span>
        {/* role="switch" + aria-checked carry the toggle semantics, and the
            VISIBLE state text is the accessible name -- deliberately no
            aria-label: a fixed label over changing button text violates
            Label in Name (WCAG 2.5.3; a voice-control "click Private" must
            hit this), so the name is what the eye reads and the sharing-line
            copy rides along as the description instead. */}
        <Button
          variant="outline"
          role="switch"
          aria-checked={shared}
          aria-describedby={copyId}
          data-testid={`visibility-toggle-${account.id}`}
          disabled={update.isPending}
          onClick={() => update.mutate({
            id: account.id,
            patch: { visibility: shared ? "private" : "shared" },
          })}
        >
          {update.isPending ? "Saving..." : shared ? "Shared" : "Private"}
        </Button>
      </div>
      {/* The sharing line, as the spec words it. */}
      <p id={copyId} className="text-xs text-slate-400">
        Private: only you see this mailbox's conversations. Threads you link to a deal or
        project become visible on that record. Shared: every CRM user sees this mailbox.
      </p>
      {update.isError && (
        <p role="alert" className="text-sm text-red-600">{update.error.message}</p>
      )}
    </div>
  );
}

/**
 * AMBER FOR 'auth_required', NOT RED, and the colour is doing work rather than
 * decorating. Red is this page's "something broke" and sits next to a Test
 * connection button; amber is "you have something to do", which is the true
 * shape of a lapsed sign-in. The WORDS carry the meaning either way
 * (accountStatusLabel), because colour alone is never a state here -- the same
 * rule the folder rows follow for their blocked reasons.
 */
function StatusBadge({ status, archived }: { status: MailAccountWithSyncStats["status"]; archived: boolean }) {
  const label = accountStatusLabel(status, archived);
  if (archived) {
    return <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{label}</span>;
  }
  if (status === "auth_required") {
    return <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">{label}</span>;
  }
  if (status === "error") {
    return <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">{label}</span>;
  }
  return <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">{label}</span>;
}

function TestResult({ result }: { result: MailAccountTestResult }) {
  return (
    <div data-testid="account-test-result" className="mt-2 flex flex-col gap-0.5">
      <ProtocolResult label="IMAP" result={result.imap} />
      <ProtocolResult label="SMTP" result={result.smtp} />
    </div>
  );
}

function ProtocolResult({ label, result }: { label: string; result: MailAccountTestResult["imap"] }) {
  if (result.ok) {
    return <p className="text-xs text-green-700">{"\u2713"} {label} connected</p>;
  }
  return (
    <p className="text-xs text-red-600">
      {"\u2717"} {label}: {friendlyMailError(result.error ?? "connection failed")}
    </p>
  );
}

/**
 * Per-account signature, saved through the ordinary account PATCH. An empty
 * editor saves as NULL rather than "" -- mailAccountUpdateInputSchema types
 * signatureHtml as a non-empty string or null, and TipTap's empty document
 * serializes to "<p></p>", which is neither empty nor meaningful.
 */
function SignatureEditor({ account }: { account: MailAccountWithSyncStats }) {
  const update = useUpdateMailAccount();
  const [html, setHtml] = useState(account.signatureHtml ?? "");

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Signature</span>
      <RichTextEditor
        initialHtml={account.signatureHtml ?? ""}
        onChange={setHtml}
        ariaLabel="Signature"
        testId={`signature-editor-${account.id}`}
      />
      <div className="flex items-center gap-3">
        <Button
          disabled={update.isPending}
          onClick={() => update.mutate({
            id: account.id,
            patch: { signatureHtml: htmlIsBlank(html) ? null : html },
          })}
        >
          {update.isPending ? "Saving..." : "Save signature"}
        </Button>
        {update.isError && <p role="alert" className="text-sm text-red-600">{update.error.message}</p>}
        {update.isSuccess && <p className="text-xs text-slate-400">Saved</p>}
      </div>
    </div>
  );
}

/**
 * The per-account folder picker (Phase 4.1): which discovered folders the CRM
 * syncs, plus the Trash/Archive targets its move actions file mail into.
 *
 * The list is the folders endpoint's, unfiltered -- including `\Noselect`
 * hierarchy nodes and folders that have vanished from the server, both of which
 * are shown greyed rather than hidden, because the CRM may still hold messages
 * filed under a name the server no longer offers and this is the only screen
 * that says so.
 */
function FolderPicker({ account }: { account: MailAccountWithSyncStats }) {
  const { data: folders, isLoading, error } = useMailFolders(account.id);
  const setSync = useSetFolderSync();

  const newest = newestDiscovery(folders ?? []);
  const detected = (use: "trash" | "archive") =>
    (folders ?? []).find((folder) => folder.specialUse === use)?.folder;

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-slate-100 pt-3">
      <span className="text-xs font-semibold uppercase text-slate-500">Folders</span>
      <p className="text-xs text-slate-400">
        Everything ticked here is synced into the CRM. Junk and Trash start switched off.
        A folder keeps whatever you set even if the server later reclassifies it {"\u2014"}
        the default is only chosen the first time a folder is seen, so this list is the way back.
      </p>

      {isLoading && <p className="text-sm text-slate-400">Loading...</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          Could not load folders: {error.message}
        </p>
      )}
      {setSync.isError && (
        <p role="alert" className="text-sm text-red-600">{setSync.error.message}</p>
      )}

      <ul className="flex flex-col gap-1">
        {(folders ?? []).map((folder) => (
          // KEYED ON THE ROW ID, NOT THE NAME, and after this task that is
          // load-bearing rather than conventional: a rename RE-KEYS the row in
          // place (api: renameFolder), so the id survives it and React keeps
          // this row's component instance -- which is what lets the rename's
          // own "N messages moved with it" still be on screen to render once
          // the list comes back under its new name. Keying on the name would
          // unmount the row that made the request and remount an idle one.
          <li key={folder.id}>
            <FolderRow
              account={account}
              folder={folder}
              stale={folder.lastDiscoveredAt < newest}
              setSync={setSync}
            />
          </li>
        ))}
      </ul>

      <NewFolderForm account={account} />

      <MoveTargets
        account={account}
        detectedTrash={detected("trash")}
        detectedArchive={detected("archive")}
        // Every selectable folder the server listed, as suggestions. A move
        // target is a mailbox NAME matched byte for byte server-side, so typing
        // one by hand is exactly as fragile as it sounds; the list the account
        // just discovered is the authority on what those bytes are.
        folderNames={(folders ?? []).filter((row) => row.selectable).map((row) => row.folder)}
      />
    </div>
  );
}

/**
 * One folder: its sync checkbox, and the two commands that change the mailbox
 * itself (Phase 4.4 Task 4).
 *
 * A COMPONENT PER ROW because a row now has state of its own -- whether it is
 * being renamed, and whether its delete confirmation is open -- and hoisting
 * either into the picker would make it "the row being renamed", which is one
 * more thing to keep in step with a list that refetches under it.
 *
 * The two commands are on every row rather than behind a per-account edit mode:
 * they are refused per FOLDER, for reasons that differ per folder (INBOX, a
 * move target, a hierarchy node, a folder the server has stopped listing), and
 * a mode would have to explain all four in one sentence somewhere else.
 */
function FolderRow({ account, folder, stale, setSync }: {
  account: MailAccountWithSyncStats;
  folder: MailAccountFolder;
  stale: boolean;
  setSync: ReturnType<typeof useSetFolderSync>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const rename = useRenameFolder();
  const remove = useDeleteFolder();
  const returnFocus = useDialogReturnFocus();

  // Locked (INBOX and the account's Sent folder) and `\Noselect` rows are both
  // refused by the API in BOTH directions -- the switch is not real either way
  // -- so the checkbox is disabled and says why rather than sending a request
  // that comes back 409.
  const why = folder.locked
    ? "Always synced: the CRM needs INBOX and Sent for sending and direction"
    : !folder.selectable
      ? "This folder holds no messages (\\Noselect)"
      : undefined;
  const renameBlocked = folderRenameBlocked(folder, { stale });
  const deleteBlocked = folderDeleteBlocked(folder, account, { stale });
  const reasons = folderCommandReasons(folder, account, { stale });

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label
          className={clsx(
            // A list row, and the label IS the row: it wraps the 13px box and
            // the folder name, so flooring it here is what makes the whole row
            // tappable rather than the checkbox alone.
            "flex min-w-0 flex-1 items-center gap-2 text-sm max-md:min-h-11",
            why === undefined ? "text-slate-700" : "text-slate-400",
          )}
          title={why}
        >
          <input
            type="checkbox"
            data-testid={`folder-picker-${folder.folder}`}
            checked={folder.syncEnabled}
            // Only the row being toggled waits, not the whole list: one PATCH
            // is one folder, and freezing eleven other checkboxes while a slow
            // server answers for the twelfth turns a curation pass into a
            // queue.
            disabled={why !== undefined
              || (setSync.isPending && setSync.variables?.input.folder === folder.folder)}
            onChange={(event) => setSync.mutate({
              accountId: account.id,
              // BY NAME, byte for byte as the endpoint listed it: that is how
              // UNIQUE (account_id, folder) matches it server-side.
              input: { folder: folder.folder, syncEnabled: event.target.checked },
            })}
            className="h-4 w-4"
          />
          <span className={clsx("truncate", stale && "italic")}>{folder.folder}</span>
          {folder.specialUse !== null && (
            <span className="shrink-0 text-[11px] uppercase text-slate-400">{folder.specialUse}</span>
          )}
          {stale && (
            <span className="shrink-0 text-[11px] text-slate-400" title="Not seen in the last sync">
              not seen in the last sync
            </span>
          )}
        </label>
        {/* A blocked command shows no button and says why, as text, below the
            row -- this codebase's rule for a blocked reason (bulk-bar.tsx): a
            `title` is invisible to touch and silent to a screen reader, and an
            unexplained missing button is worse than either. */}
        {renameBlocked === null && !renaming && (
          <Button
            variant="ghost" className="shrink-0 px-2 py-1 text-xs"
            data-testid={`folder-rename-${folder.folder}`}
            onClick={() => { rename.reset(); setRenaming(true); }}
          >
            Rename
          </Button>
        )}
        {deleteBlocked === null && (
          <Button
            variant="ghost" className="shrink-0 px-2 py-1 text-xs text-red-600"
            data-testid={`folder-delete-${folder.folder}`}
            onClick={(event) => {
              remove.reset();
              returnFocus.capture(event.currentTarget);
              setConfirmingDelete(true);
            }}
          >
            Delete
          </Button>
        )}
      </div>

      {reasons.map((reason) => (
        <p key={reason} className="pl-6 text-xs text-slate-400">{reason}</p>
      ))}

      {renaming && (
        <RenameFolderForm
          accountId={account.id}
          folder={folder.folder}
          rename={rename}
          onClose={() => setRenaming(false)}
        />
      )}
      {/* The one thing the rename says AFTERWARDS, and it has to: renaming a
          folder silently re-keys every message stored under it, and an operator
          who is not told is left to notice by searching for something that
          stops matching. */}
      {rename.isSuccess && !renaming && rename.variables.accountId === account.id
        && rename.data.folder.folder === folder.folder && (
        <p className="text-xs text-slate-500">
          {`Renamed. ${String(rename.data.messages)} stored `}
          {rename.data.messages === 1 ? "message" : "messages"}
          {` moved with it, across ${String(rename.data.folders)} `}
          {rename.data.folders === 1 ? "folder" : "folders"}.
        </p>
      )}
      {remove.isSuccess && remove.variables.accountId === account.id
        && remove.variables.input.folder === folder.folder && (
        <p className="text-xs text-slate-500">
          {`Deleted from the mail server. Conduit kept ${String(remove.data.messages)} stored `}
          {remove.data.messages === 1 ? "message" : "messages"} from it.
        </p>
      )}

      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => { if (!open) setConfirmingDelete(false); }}
      >
        <DialogContent onCloseAutoFocus={returnFocus.restore}>
          <div className="flex flex-col gap-3">
            <DialogTitle>{`Delete "${folder.folder}"?`}</DialogTitle>
            {folderDeleteWarning(folder.folder).map((line) => (
              <p key={line} className="text-sm text-slate-600">{line}</p>
            ))}
            {remove.isError && (
              <p role="alert" className="text-sm text-red-600">{remove.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              <Button
                variant="danger"
                data-testid="folder-delete-confirm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(
                  { accountId: account.id, input: { folder: folder.folder } },
                  // Closed only on SUCCESS: a refusal ("still holds 12
                  // messages") belongs where the question was asked, not
                  // stranded behind a dialog that has just shut.
                  { onSuccess: () => setConfirmingDelete(false) },
                )}
              >
                {remove.isPending ? "Deleting..." : "Delete the folder"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The inline rename editor. A form so Enter submits, and `autoFocus` because
 * below the breakpoint DialogContent's injected Close is otherwise the first
 * tabbable thing on screen (dialog.tsx's hazard note) -- the same discipline
 * applied to an inline editor costs nothing and means the keyboard lands where
 * the eye does. */
function RenameFolderForm({ accountId, folder, rename, onClose }: {
  accountId: string;
  folder: string;
  rename: ReturnType<typeof useRenameFolder>;
  onClose: () => void;
}) {
  const [name, setName] = useState(folder);
  const trimmed = name.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed === "" || trimmed === folder) return;
    rename.mutate(
      { accountId, input: { folder, newFolder: trimmed } },
      { onSuccess: onClose },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1 pl-6">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid={`folder-rename-input-${folder}`}
          disabled={rename.isPending}
          className="h-8 flex-1 text-sm"
          aria-label={`New name for ${folder}`}
        />
        <Button
          type="submit" className="shrink-0 px-2 py-1 text-xs"
          data-testid={`folder-rename-save-${folder}`}
          // Same name is not a no-op that quietly succeeds: the shared schema
          // rejects it outright, so the control refuses it before the request.
          disabled={rename.isPending || trimmed === "" || trimmed === folder}
        >
          {rename.isPending ? "Renaming..." : "Save"}
        </Button>
        <Button
          variant="ghost" className="shrink-0 px-2 py-1 text-xs"
          disabled={rename.isPending} onClick={onClose}
        >
          Cancel
        </Button>
      </div>
      <p className="text-xs text-slate-400">
        The folder is renamed on the mail server, and every message Conduit stored from it {"—"}
        and from any folder inside it {"—"} moves with it. Type the full path to move it
        somewhere else in the hierarchy.
      </p>
      {rename.isError && (
        <p role="alert" className="text-sm text-red-600">{rename.error.message}</p>
      )}
    </form>
  );
}

/** Make a folder on the mail server. Inline rather than in a dialog: it is one
 * field, it belongs at the foot of the list it adds to, and the list is where
 * the result appears. */
function NewFolderForm({ account }: { account: MailAccountWithSyncStats }) {
  const [name, setName] = useState("");
  const create = useCreateFolder();
  const trimmed = name.trim();

  function submit(event: FormEvent) {
    event.preventDefault();
    if (trimmed === "") return;
    create.mutate(
      { accountId: account.id, input: { folder: trimmed } },
      { onSuccess: () => setName("") },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-1 border-t border-slate-100 pt-2">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New folder name"
          data-testid={`folder-create-input-${account.id}`}
          disabled={create.isPending}
          className="h-8 flex-1 text-sm"
          aria-label="New folder name"
        />
        <Button
          type="submit" className="shrink-0 px-2 py-1 text-xs"
          data-testid={`folder-create-${account.id}`}
          disabled={create.isPending || trimmed === ""}
        >
          {create.isPending ? "Creating..." : "Create"}
        </Button>
      </div>
      <p className="text-xs text-slate-400">
        Made on the mail server and synced from the start {"—"} unlike a folder Conduit
        merely discovers, one you make here is one you have asked for. Use the server{"’"}s
        own separator for a folder inside another, as the names above spell it.
      </p>
      {create.isError && (
        <p role="alert" className="text-sm text-red-600">{create.error.message}</p>
      )}
    </form>
  );
}

/**
 * Where Trash and Archive put mail for this account.
 *
 * BLANK MEANS "DETECT THIS FOR ME": the column goes back to NULL and the next
 * discovery pass refills it from the server's SPECIAL-USE attributes (api:
 * mail-folders.ts's fillMoveTargets, which only ever writes into a NULL). The
 * placeholder therefore shows what discovery has ALREADY classified, when it
 * has classified anything -- so an empty field is never a mystery. A bulk
 * action against an account with neither a stored nor a detected target fails
 * that account's threads with `no_target` rather than guessing.
 */
function MoveTargets({
  account, detectedTrash, detectedArchive, folderNames,
}: {
  account: MailAccountWithSyncStats;
  detectedTrash: string | undefined;
  detectedArchive: string | undefined;
  folderNames: readonly string[];
}) {
  const update = useUpdateMailAccount();
  // null is UNTOUCHED, and the difference is load-bearing: what these fields
  // SHOW falls back to the account, and what they SAVE is only what was edited
  // (mail-lib's moveTargetPatch). Seeding them with the account's values at
  // mount, the way this used to, meant a save could send a stale empty string
  // for a field a discovery pass had filled in the meantime -- wiping a target
  // the user never touched.
  const [trash, setTrash] = useState<string | null>(null);
  const [archiveTo, setArchiveTo] = useState<string | null>(null);

  const placeholder = (detectedValue: string | undefined) =>
    (detectedValue === undefined ? "Detect for me" : `Detect for me (${detectedValue})`);

  const patch = moveTargetPatch(trash, archiveTo, account);
  const nothingToSave = Object.keys(patch).length === 0;
  const listId = `folder-options-${account.id}`;

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-slate-100 pt-2">
      {/* One list for both fields: either target may be any mailbox. */}
      <datalist id={listId}>
        {folderNames.map((name) => <option key={name} value={name} />)}
      </datalist>
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Trash folder" testId="trash-folder">
          <Input
            value={trash ?? account.trashFolder ?? ""}
            onChange={(event) => setTrash(event.target.value)}
            placeholder={placeholder(detectedTrash)}
            list={listId}
            data-testid={`trash-folder-${account.id}`}
          />
        </Field>
        <Field label="Archive folder" testId="archive-folder">
          <Input
            value={archiveTo ?? account.archiveFolder ?? ""}
            onChange={(event) => setArchiveTo(event.target.value)}
            placeholder={placeholder(detectedArchive)}
            list={listId}
            data-testid={`archive-folder-${account.id}`}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          data-testid={`save-move-targets-${account.id}`}
          disabled={update.isPending || nothingToSave}
          onClick={() => update.mutate(
            { id: account.id, patch },
            // Back to "untouched" on success, so the fields go on showing the
            // account -- which is now what was just saved, and will be whatever
            // a later discovery pass fills in.
            { onSuccess: () => { setTrash(null); setArchiveTo(null); } },
          )}
        >
          {update.isPending ? "Saving..." : "Save folders"}
        </Button>
        {update.isError && <p role="alert" className="text-sm text-red-600">{update.error.message}</p>}
        {/* Only while nothing has been typed since: "Saved" beside a field
            holding unsaved edits is a lie about the field next to it. */}
        {update.isSuccess && nothingToSave && <p className="text-xs text-slate-400">Saved</p>}
      </div>
    </div>
  );
}

/**
 * The dialog's one job before either form renders: which of the two paths this
 * account is on.
 *
 * THE EXISTING PASSWORD PATH IS UNTOUCHED, which is the spec's requirement in
 * as many words -- a self-hosted IMAP server with a password is still the
 * common case on this install, and it is what an install with no app
 * registration gets with no choice to make at all. The chooser appears only
 * when there is something to choose between.
 *
 * AN EDIT NEVER OFFERS THE CHOICE. How an account authenticates is not a
 * setting (mail_accounts.auth_method is deliberately not patchable): a password
 * mailbox becomes an OAuth one by being added again and the old row archived,
 * because the addresses need not match and the stored password would be
 * destroyed on the way. The server refuses the conversion too
 * (replaceOAuthCredentials); this is the same rule where the operator meets it.
 */
function AccountForm({
  account,
  onClose,
}: {
  account?: MailAccountWithSyncStats;
  onClose: () => void;
}) {
  const oauth = useMailOAuthProviders();
  const editingProvider = account === undefined ? null : mailOAuthProviderOf(account.authMethod);
  const [method, setMethod] = useState<MailSigninMethod>(editingProvider ?? "password");
  const providers = oauth.data?.providers ?? [];

  if (editingProvider !== null) {
    return <OAuthAccountForm account={account} provider={editingProvider} onClose={onClose} />;
  }
  if (account !== undefined) return <PasswordAccountForm account={account} onClose={onClose} />;
  // WAIT RATHER THAN GUESS, and the page above has usually made this instant:
  // it calls the same hook on mount, so by the time the dialog opens the answer
  // is in the cache. Defaulting to the password form while the answer is in
  // flight would render it and then swap it out from under a reader who had
  // already started typing -- and the swap only happens on the installs that
  // have a registration, which is the population least able to spare the
  // confusion. A failed fetch falls through to the password path below, which
  // is the honest answer: this install cannot offer a provider it cannot name.
  if (oauth.isPending) {
    return (
      <div className="flex flex-col gap-4">
        <DialogTitle>Add mail account</DialogTitle>
        <p className="text-sm text-slate-400">Loading...</p>
      </div>
    );
  }
  // NO REGISTRATION: the password form, and a sentence saying why that is the
  // only option. Task 3 was right not to offer a button that can only 409; what
  // it left was an absence, and an absence reads as a missing feature rather
  // than as a deployment step nobody has taken yet. See oauthSetupHint.
  if (providers.length === 0) {
    // `oauth.data` rather than the defaulted `providers`: this branch is also
    // where a FAILED fetch lands, and a hint built from a callbackPath nobody
    // answered would tell the operator to register the site root. Which of
    // those two it is, is oauthSetupHint's decision -- it returns null and this
    // renders nothing, rather than the guard living here where no test reaches.
    const hint = oauthSetupHint(oauth.data?.callbackPath, window.location.origin);
    return (
      <div className="flex flex-col gap-4">
        {hint !== null && (
          <p data-testid="oauth-setup-hint" className="text-xs text-slate-500">{hint}</p>
        )}
        <PasswordAccountForm onClose={onClose} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <DialogTitle>Add mail account</DialogTitle>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-semibold uppercase text-slate-500">How does it sign in?</legend>
        {/* Radios, not tabs: this is one question with one answer, and a radio
            group is the control a screen reader announces that way. Password is
            first and pre-selected because it is the common case here. */}
        {(["password", ...providers] as MailSigninMethod[]).map((option) => (
          <label key={option} className={CHECKBOX_LABEL}>
            <input
              type="radio"
              name="signin-method"
              value={option}
              checked={method === option}
              onChange={() => setMethod(option)}
            />
            {option === "password" ? "Password (IMAP and SMTP)" : providerLabel(option)}
          </label>
        ))}
      </fieldset>
      {method === "password"
        ? <PasswordAccountForm onClose={onClose} embedded />
        : <OAuthAccountForm provider={method} onClose={onClose} embedded />}
    </div>
  );
}

/**
 * The OAuth path: a label, an address, and a button that leaves for the
 * provider.
 *
 * NO HOST, PORT, SECURITY, USERNAME OR PASSWORD, and their absence is the
 * feature. Those are the provider's and known (api:
 * services/mail-oauth-signin.ts's provider table), the mailbox address IS the
 * username, and there is no password to ask for. Everything this form has is
 * something only the operator knows.
 *
 * CREATING LEAVES THE PAGE; EDITING DOES NOT. On a create, the submit hands the
 * browser to the consent screen and the account appears when the callback
 * brings it back -- so there is no create mutation here at all. On an edit, the
 * three fields that are still this install's business are PATCHed like any
 * other setting, and ReauthorizeButton is a separate control because renewing a
 * grant is a different act from renaming a mailbox.
 */
function OAuthAccountForm({
  account,
  provider,
  onClose,
  embedded = false,
}: {
  account?: MailAccountWithSyncStats;
  provider: MailOAuthProvider;
  onClose: () => void;
  /** Rendered inside the chooser above, which already carries the title. */
  embedded?: boolean;
}) {
  const isEdit = account !== undefined;
  const [state, setState] = useState<OAuthFormState>(() => initialOAuthFormState(account));
  const [localError, setLocalError] = useState<string | null>(null);
  const update = useUpdateMailAccount();
  const signin = useStartMailOAuthSignin();

  function set<K extends keyof OAuthFormState>(key: K, value: OAuthFormState[K]) {
    setState((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validateOAuthForm(state, isEdit);
    if (problem !== null) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    if (account === undefined) {
      signin.mutate(buildOAuthSigninInput(state, provider), {
        onSuccess: ({ authorizeUrl }) => { window.location.assign(authorizeUrl); },
      });
      return;
    }
    update.mutate({ id: account.id, patch: buildOAuthUpdatePatch(state) }, { onSuccess: onClose });
  }

  const pending = signin.isPending || update.isPending;
  const submitError = signin.error ?? update.error;

  return (
    <form data-testid="oauth-account-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
      {!embedded && <DialogTitle>Edit mail account</DialogTitle>}

      <p className="text-xs text-slate-500">
        {isEdit
          ? `${signedInWith(account.authMethod) ?? ""}. The server settings come from ${providerLabel(provider)}, so there is nothing to configure here.`
          : `You will be sent to ${providerLabel(provider)} to sign in. Conduit never sees the password — it stores the sign-in ${providerLabel(provider)} gives back, encrypted.`}
      </p>

      {/* THE GMAIL FORK, AT THE POINT OF CHOOSING (Phase 8 Task 4).
          ON THE CREATE FORM ONLY, and the omission on an edit is the same
          judgement the caveat itself is: this is information for a decision,
          and by the time the account exists the decision is made. Repeating it
          on every visit to a working account's settings would train the reader
          to skip the box -- and the moment it becomes relevant again (the grant
          lapsing on the seventh day) is covered where that actually shows up,
          in accountReauthMessage on the account's own row.
          A styled callout rather than the small grey paragraph above it,
          because it is the one thing on this form that can make the mailbox not
          work, and prose that looks like the surrounding hint text gets read
          like the surrounding hint text. */}
      {!isEdit && (() => {
        const caveat = providerSigninCaveat(provider);
        if (caveat === null) return null;
        return (
          <div
            data-testid="oauth-provider-caveat"
            // role="alert", matching this codebase's other amber warning boxes
            // (board.tsx, and the callback banner on this page). It APPEARS
            // when the operator picks Google, so without a live region a screen
            // reader user meets the consequences and never the warning -- which
            // is the exact failure the box exists to prevent, aimed at the
            // person least able to recover from it.
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
          >
            <p className="font-semibold">{caveat.heading}</p>
            {caveat.paragraphs.map((text) => <p key={text}>{text}</p>)}
          </div>
        );
      })()}

      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Label" testId="oauth-label">
          <Input value={state.label} onChange={(e) => set("label", e.target.value)} placeholder="Work" autoFocus />
        </Field>
        <Field label="Mailbox address" testId="oauth-email">
          <Input
            type="email"
            value={state.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="you@example.com"
            // The address is the mailbox the grant was issued for, and the
            // username XOAUTH2 authenticates as. Changing it would leave a
            // token that authenticates somebody else, so it is fixed once the
            // account exists -- signing in to a different mailbox means adding
            // one.
            disabled={isEdit}
            autoComplete="username"
          />
        </Field>
      </div>

      {isEdit && (
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <Field label="Sent folder" testId="oauth-sent-folder">
            {/* Filled in per provider when the account was created ("Sent
                Items", "[Gmail]/Sent Mail") and editable because a mailbox with
                a non-default namespace can prove that starting value wrong. */}
            <Input value={state.sentFolder} onChange={(e) => set("sentFolder", e.target.value)} />
          </Field>
          <Field label="Backfill" testId="oauth-backfill">
            <BackfillSelect value={state.backfill} onChange={(value) => set("backfill", value)} account={account} />
          </Field>
        </div>
      )}
      {!isEdit && (
        <Field label="Backfill" testId="oauth-backfill">
          <BackfillSelect value={state.backfill} onChange={(value) => set("backfill", value)} />
        </Field>
      )}

      {localError !== null && <p role="alert" className="text-sm text-red-600">{localError}</p>}
      {submitError && <p role="alert" className="text-sm text-red-600">{submitError.message}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Opening..." : isEdit ? "Save changes" : `Continue with ${providerLabel(provider)}`}
        </Button>
      </div>
    </form>
  );
}

/** The 30/90/Everything control, shared by both forms so a backfill window an
 * account already has cannot be silently rewritten by whichever form happens to
 * open. */
function BackfillSelect({
  value, onChange, account,
}: {
  value: string; onChange: (value: string) => void; account?: MailAccountWithSyncStats;
}) {
  const options = [...new Set([
    "30", "90", ...(account?.backfillDays != null ? [String(account.backfillDays)] : []),
  ])];
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger ariaLabel="Backfill">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((days) => <SelectItem key={days} value={days}>Last {days} days</SelectItem>)}
        <SelectItem value="all">Everything</SelectItem>
      </SelectContent>
    </Select>
  );
}

function PasswordAccountForm({
  account,
  onClose,
  embedded = false,
}: {
  account?: MailAccountWithSyncStats;
  onClose: () => void;
  /** Rendered inside the chooser above, which already carries the title. */
  embedded?: boolean;
}) {
  const isEdit = account !== undefined;
  const { data: me } = useMe();
  const [state, setState] = useState<AccountFormState>(() => initialFormState(account));
  const [localError, setLocalError] = useState<string | null>(null);
  const create = useCreateMailAccount();
  const update = useUpdateMailAccount();
  const test = useTestMailAccount();

  function set<K extends keyof AccountFormState>(key: K, value: AccountFormState[K]) {
    setState((current) => ({ ...current, [key]: value }));
  }

  function applyDovecotPreset() {
    setState((current) => dovecotPreset(current, me?.username));
  }

  function handleTest() {
    const problem = validateForm(state, isEdit);
    if (problem !== null) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    test.mutate(buildTestInput(state, account?.id));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = validateForm(state, isEdit);
    if (problem !== null) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    if (account === undefined) {
      create.mutate(buildCreateInput(state), { onSuccess: onClose });
      return;
    }
    update.mutate({ id: account.id, patch: buildUpdatePatch(state) }, { onSuccess: onClose });
  }

  const pending = create.isPending || update.isPending;
  const submitError = create.error ?? update.error;
  // 30/90 plus, for an account stored with anything else, its own value --
  // so opening the form never silently rewrites a backfill window the UI has
  // no button for.
  const backfillOptions = [...new Set(["30", "90", ...(isEdit && account.backfillDays !== null ? [String(account.backfillDays)] : [])])];

  return (
    <form data-testid="account-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* The chooser above already carries the title when this form is one of
          its two branches; a second DialogTitle would announce twice. */}
      {!embedded && <DialogTitle>{isEdit ? "Edit mail account" : "Add mail account"}</DialogTitle>}

      {/*
        Every field grid in this file collapses to one column below the
        breakpoint -- the phase's "forms single-column, inputs full-width"
        rule. This is the widest form in the app (a three-column row of
        host/port/security twice over), and a 327px phone gives each of those
        cells about 100px.
      */}
      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Label" testId="label">
          <Input value={state.label} onChange={(e) => set("label", e.target.value)} placeholder="Work" autoFocus />
        </Field>
        <Field label="Email address" testId="email">
          <Input
            type="email"
            value={state.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-slate-500">Server</span>
        <Button variant="ghost" onClick={applyDovecotPreset}>Local Dovecot</Button>
      </div>

      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        <Field label="IMAP host" testId="imap-host">
          <Input value={state.imapHost} onChange={(e) => set("imapHost", e.target.value)} />
        </Field>
        <Field label="IMAP port" testId="imap-port">
          <Input value={state.imapPort} onChange={(e) => set("imapPort", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="IMAP security" testId="imap-security">
          <SecuritySelect value={state.imapSecurity} onChange={(value) => set("imapSecurity", value)} ariaLabel="IMAP security" />
        </Field>
        <Field label="SMTP host" testId="smtp-host">
          <Input value={state.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} />
        </Field>
        <Field label="SMTP port" testId="smtp-port">
          <Input value={state.smtpPort} onChange={(e) => set("smtpPort", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="SMTP security" testId="smtp-security">
          <SecuritySelect value={state.smtpSecurity} onChange={(value) => set("smtpSecurity", value)} ariaLabel="SMTP security" />
        </Field>
      </div>

      <Field label="Username" testId="username">
        <Input value={state.username} onChange={(e) => set("username", e.target.value)} autoComplete="username" />
      </Field>

      <label className={CHECKBOX_LABEL}>
        <input
          type="checkbox"
          checked={state.smtpDiffers}
          onChange={(e) => set("smtpDiffers", e.target.checked)}
        />
        SMTP password differs from IMAP
      </label>

      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label={state.smtpDiffers ? "IMAP password" : "Password"} testId="password">
          <Input
            type="password"
            value={state.password}
            onChange={(e) => set("password", e.target.value)}
            autoComplete="new-password"
            placeholder={isEdit ? "Leave blank to keep the stored password" : ""}
          />
        </Field>
        {state.smtpDiffers && (
          <Field label="SMTP password" testId="smtp-password">
            <Input
              type="password"
              value={state.smtpPassword}
              onChange={(e) => set("smtpPassword", e.target.value)}
              autoComplete="new-password"
              placeholder={isEdit ? "Leave blank to keep the stored password" : ""}
            />
          </Field>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
        <Field label="Sent folder" testId="sent-folder">
          <Input value={state.sentFolder} onChange={(e) => set("sentFolder", e.target.value)} />
        </Field>
        <Field label="Backfill" testId="backfill">
          <Select value={state.backfill} onValueChange={(value) => set("backfill", value)}>
            <SelectTrigger ariaLabel="Backfill">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {backfillOptions.map((days) => (
                <SelectItem key={days} value={days}>Last {days} days</SelectItem>
              ))}
              <SelectItem value="all">Everything</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" onClick={handleTest} disabled={test.isPending}>
          {test.isPending ? "Testing..." : "Test connection"}
        </Button>
        {test.isError && <p role="alert" className="text-sm text-red-600">{test.error.message}</p>}
      </div>
      {test.data !== undefined && <TestResult result={test.data} />}

      {localError !== null && <p role="alert" className="text-sm text-red-600">{localError}</p>}
      {submitError && <p role="alert" className="text-sm text-red-600">{submitError.message}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : isEdit ? "Save changes" : "Add account"}
        </Button>
      </div>
    </form>
  );
}

/** One labelled form control. The wrapper carries `field-<testId>`, mirroring
 * task-drawer.tsx's Field, so a test can address a control whose own element
 * is a Radix trigger rather than a plain input. */
function Field({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      <div data-testid={`field-${testId}`}>{children}</div>
    </label>
  );
}

function SecuritySelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: MailSecurity;
  onChange: (value: MailSecurity) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as MailSecurity)}>
      <SelectTrigger ariaLabel={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="tls">TLS</SelectItem>
        <SelectItem value="starttls">STARTTLS</SelectItem>
      </SelectContent>
    </Select>
  );
}
