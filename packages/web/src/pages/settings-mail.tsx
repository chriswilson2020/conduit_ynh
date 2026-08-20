import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { clsx } from "clsx";
import type { MailAccountTestResult, MailAccountWithSyncStats, MailSecurity } from "@conduit/shared";
import { relativeTime } from "../lib";
import {
  useArchiveMailAccount,
  useCreateMailAccount,
  useMailAccounts,
  useMailFolders,
  useMe,
  useSetFolderSync,
  useTestMailAccount,
  useUnarchiveMailAccount,
  useUpdateMailAccount,
} from "../queries";
import { friendlyMailError, htmlIsBlank, newestDiscovery } from "../components/mail/mail-lib";
import {
  buildCreateInput,
  buildTestInput,
  buildUpdatePatch,
  dovecotPreset,
  initialFormState,
  validateForm,
  type AccountFormState,
} from "./settings-mail-lib";
import { RichTextEditor } from "../components/mail/rich-text";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

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

  const own = data?.own ?? [];
  const active = own.filter((account) => account.archivedAt === null);
  const archived = own.filter((account) => account.archivedAt !== null);
  const others = data?.others ?? [];

  return (
    <SettingsLayout>
      <div data-testid="mail-settings" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Your mail accounts</h2>
          <Button onClick={() => setFormTarget({})}>Add account</Button>
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
            onEdit={() => setFormTarget({ account })}
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
              <AccountCard key={account.id} account={account} onEdit={() => setFormTarget({ account })} />
            ))}
          </section>
        )}

        {others.length > 0 && (
          <section className="flex flex-col gap-1">
            <h2 className="mt-4 text-sm font-semibold text-slate-900">Other users' mailboxes</h2>
            <p className="text-xs text-slate-400">
              Their threads are visible to you; their settings are not.
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
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
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
  onEdit: () => void;
}) {
  const test = useTestMailAccount();
  const archive = useArchiveMailAccount();
  const unarchive = useUnarchiveMailAccount();
  const [showSignature, setShowSignature] = useState(false);
  const [showFolders, setShowFolders] = useState(false);
  const isArchived = account.archivedAt !== null;

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
              <Button variant="outline" onClick={onEdit}>Edit</Button>
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

      {showSignature && !isArchived && <SignatureEditor account={account} />}
      {/* Folders stay editable on an ARCHIVED account too: its rows survive
          (archive-not-delete), curating them while the mailbox is put away is
          reasonable, and the API refuses none of it -- enabling one simply
          finds no sync loop to ask for a pass. */}
      {showFolders && <FolderPicker account={account} />}
    </section>
  );
}

function StatusBadge({ status, archived }: { status: MailAccountWithSyncStats["status"]; archived: boolean }) {
  if (archived) {
    return <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">Archived</span>;
  }
  if (status === "error") {
    return <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Error</span>;
  }
  return <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Active</span>;
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
        {(folders ?? []).map((folder) => {
          // Locked (INBOX and the account's Sent folder) and `\Noselect` rows
          // are both refused by the API in BOTH directions -- the switch is not
          // real either way -- so the checkbox is disabled and says why rather
          // than sending a request that comes back 409.
          const why = folder.locked
            ? "Always synced: the CRM needs INBOX and Sent for sending and direction"
            : !folder.selectable
              ? "This folder holds no messages (\\Noselect)"
              : undefined;
          const stale = folder.lastDiscoveredAt < newest;
          return (
            <li key={folder.id}>
              <label
                className={clsx(
                  "flex items-center gap-2 text-sm",
                  why === undefined ? "text-slate-700" : "text-slate-400",
                )}
                title={why}
              >
                <input
                  type="checkbox"
                  data-testid={`folder-picker-${folder.folder}`}
                  checked={folder.syncEnabled}
                  disabled={why !== undefined || setSync.isPending}
                  onChange={(event) => setSync.mutate({
                    accountId: account.id,
                    // BY NAME, byte for byte as the endpoint listed it: that is
                    // how UNIQUE (account_id, folder) matches it server-side.
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
            </li>
          );
        })}
      </ul>

      <MoveTargets
        account={account}
        detectedTrash={detected("trash")}
        detectedArchive={detected("archive")}
      />
    </div>
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
  account, detectedTrash, detectedArchive,
}: {
  account: MailAccountWithSyncStats;
  detectedTrash: string | undefined;
  detectedArchive: string | undefined;
}) {
  const update = useUpdateMailAccount();
  const [trash, setTrash] = useState(account.trashFolder ?? "");
  const [archiveTo, setArchiveTo] = useState(account.archiveFolder ?? "");

  const placeholder = (detectedValue: string | undefined) =>
    (detectedValue === undefined ? "Detect for me" : `Detect for me (${detectedValue})`);

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-slate-100 pt-2">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Trash folder" testId="trash-folder">
          <Input
            value={trash}
            onChange={(event) => setTrash(event.target.value)}
            placeholder={placeholder(detectedTrash)}
            data-testid={`trash-folder-${account.id}`}
          />
        </Field>
        <Field label="Archive folder" testId="archive-folder">
          <Input
            value={archiveTo}
            onChange={(event) => setArchiveTo(event.target.value)}
            placeholder={placeholder(detectedArchive)}
            data-testid={`archive-folder-${account.id}`}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button
          data-testid={`save-move-targets-${account.id}`}
          disabled={update.isPending}
          onClick={() => update.mutate({
            id: account.id,
            // null, not "": the shared schema rejects a blank string outright,
            // and null is the meaningful "not resolved yet" value the next
            // discovery pass refills. Trimming is the service's job (mirroring
            // normalizeSentFolder), but a whitespace-only field is a blank one
            // here, not a folder called "   ".
            patch: {
              trashFolder: trash.trim() === "" ? null : trash.trim(),
              archiveFolder: archiveTo.trim() === "" ? null : archiveTo.trim(),
            },
          })}
        >
          {update.isPending ? "Saving..." : "Save folders"}
        </Button>
        {update.isError && <p role="alert" className="text-sm text-red-600">{update.error.message}</p>}
        {update.isSuccess && <p className="text-xs text-slate-400">Saved</p>}
      </div>
    </div>
  );
}

function AccountForm({
  account,
  onClose,
}: {
  account?: MailAccountWithSyncStats;
  onClose: () => void;
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
      <DialogTitle>{isEdit ? "Edit mail account" : "Add mail account"}</DialogTitle>

      <div className="grid grid-cols-2 gap-3">
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

      <div className="grid grid-cols-3 gap-3">
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

      <label className="flex items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={state.smtpDiffers}
          onChange={(e) => set("smtpDiffers", e.target.checked)}
        />
        SMTP password differs from IMAP
      </label>

      <div className="grid grid-cols-2 gap-3">
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

      <div className="grid grid-cols-2 gap-3">
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
