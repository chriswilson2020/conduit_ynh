import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type {
  MailAccountCreateInput, MailAccountTestInput, MailAccountTestResult, MailAccountWithSyncStats,
  MailSecurity,
} from "@conduit/shared";
import { relativeTime } from "../lib";
import {
  useArchiveMailAccount,
  useCreateMailAccount,
  useMailAccounts,
  useMe,
  useTestMailAccount,
  useUnarchiveMailAccount,
  useUpdateMailAccount,
  type MailAccountPatch,
} from "../queries";
import { friendlyMailError, htmlIsBlank } from "../components/mail/composer-lib";
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

const LOCAL_DOVECOT = {
  imapHost: "localhost", imapPort: "993", imapSecurity: "tls" as MailSecurity,
  smtpHost: "localhost", smtpPort: "587", smtpSecurity: "starttls" as MailSecurity,
};

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

interface AccountFormState {
  label: string;
  email: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: MailSecurity;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: MailSecurity;
  username: string;
  /**
   * The form's two password states, and there is no third one (see
   * mail-accounts.ts's updateAccount doc comment): off submits `password`
   * alone, which the server applies to BOTH protocols; on submits `password`
   * and `smtpPassword` together.
   */
  smtpDiffers: boolean;
  password: string;
  smtpPassword: string;
  sentFolder: string;
  /** "30" | "90" | "all", or an existing account's own stored value. */
  backfill: string;
}

function initialFormState(account?: MailAccountWithSyncStats): AccountFormState {
  if (account === undefined) {
    return {
      label: "", email: "",
      imapHost: "", imapPort: "993", imapSecurity: "tls",
      smtpHost: "", smtpPort: "587", smtpSecurity: "starttls",
      username: "", smtpDiffers: false, password: "", smtpPassword: "",
      sentFolder: "Sent", backfill: "90",
    };
  }
  return {
    label: account.label, email: account.email,
    imapHost: account.imapHost, imapPort: String(account.imapPort), imapSecurity: account.imapSecurity,
    smtpHost: account.smtpHost, smtpPort: String(account.smtpPort), smtpSecurity: account.smtpSecurity,
    username: account.username,
    // Password fields always start blank on an edit: blank means "keep the
    // stored password", and a stored credential is never sent to a client to
    // pre-fill them with in the first place.
    smtpDiffers: false, password: "", smtpPassword: "",
    sentFolder: account.sentFolder,
    backfill: account.backfillDays === null ? "all" : String(account.backfillDays),
  };
}

function isPort(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535;
}

/** The one field-level validation gate, shared by Save and Test connection --
 * a test with half a form is as useless as a save with one. */
function validateForm(state: AccountFormState, isEdit: boolean): string | null {
  if (state.label.trim() === "") return "A label is required.";
  if (state.email.trim() === "") return "An email address is required.";
  if (state.imapHost.trim() === "" || state.smtpHost.trim() === "") return "IMAP and SMTP hosts are required.";
  if (!isPort(state.imapPort) || !isPort(state.smtpPort)) return "Ports must be whole numbers between 1 and 65535.";
  if (state.username.trim() === "") return "A username is required.";
  if (!isEdit && state.password === "") return "A password is required.";
  if (state.smtpDiffers && (state.password === "") !== (state.smtpPassword === "")) {
    return isEdit
      ? "With separate SMTP credentials, fill in both password fields, or leave both blank to keep the stored ones."
      : "Enter both the IMAP and the SMTP password.";
  }
  return null;
}

/** The non-credential half of the submission, identical for create and
 * update -- the server no-ops fields whose value has not changed. */
function settingsFields(state: AccountFormState) {
  return {
    label: state.label.trim(),
    email: state.email.trim(),
    imapHost: state.imapHost.trim(),
    imapPort: Number(state.imapPort),
    imapSecurity: state.imapSecurity,
    smtpHost: state.smtpHost.trim(),
    smtpPort: Number(state.smtpPort),
    smtpSecurity: state.smtpSecurity,
    username: state.username.trim(),
    sentFolder: state.sentFolder.trim() === "" ? "Sent" : state.sentFolder.trim(),
    backfillDays: state.backfill === "all" ? null : Number(state.backfill),
  };
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
    setState((current) => ({
      ...current,
      ...LOCAL_DOVECOT,
      // The account's own mailbox login on a YunoHost box is the LDAP
      // username -- the same identity this session is authenticated as.
      username: me?.username ?? current.username,
    }));
  }

  function handleTest() {
    const problem = validateForm(state, isEdit);
    if (problem !== null) {
      setLocalError(problem);
      return;
    }
    setLocalError(null);
    const overrides = {
      imapHost: state.imapHost.trim(), imapPort: Number(state.imapPort), imapSecurity: state.imapSecurity,
      smtpHost: state.smtpHost.trim(), smtpPort: Number(state.smtpPort), smtpSecurity: state.smtpSecurity,
      username: state.username.trim(),
      // Blank password fields are OMITTED, never sent as "":
      // mailAccountTestInputSchema holds them to .min(1), and on a stored
      // account an absent password is exactly what makes the test use the
      // saved credentials.
      ...(state.password !== "" ? { password: state.password } : {}),
      ...(state.smtpDiffers && state.smtpPassword !== "" ? { smtpPassword: state.smtpPassword } : {}),
    } satisfies MailAccountTestInput;
    test.mutate(account !== undefined ? { accountId: account.id, ...overrides } : overrides);
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
      const input: MailAccountCreateInput = {
        ...settingsFields(state),
        password: state.password,
        ...(state.smtpDiffers ? { smtpPassword: state.smtpPassword } : {}),
      };
      create.mutate(input, { onSuccess: onClose });
      return;
    }
    const patch: MailAccountPatch = {
      ...settingsFields(state),
      ...(state.password !== "" ? { password: state.password } : {}),
      ...(state.smtpDiffers && state.smtpPassword !== "" ? { smtpPassword: state.smtpPassword } : {}),
    };
    update.mutate({ id: account.id, patch }, { onSuccess: onClose });
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
        <Field label="Label">
          <Input value={state.label} onChange={(e) => set("label", e.target.value)} placeholder="Work" autoFocus />
        </Field>
        <Field label="Email address">
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
        <Field label="IMAP host">
          <Input value={state.imapHost} onChange={(e) => set("imapHost", e.target.value)} />
        </Field>
        <Field label="IMAP port">
          <Input value={state.imapPort} onChange={(e) => set("imapPort", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="IMAP security">
          <SecuritySelect value={state.imapSecurity} onChange={(value) => set("imapSecurity", value)} />
        </Field>
        <Field label="SMTP host">
          <Input value={state.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} />
        </Field>
        <Field label="SMTP port">
          <Input value={state.smtpPort} onChange={(e) => set("smtpPort", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="SMTP security">
          <SecuritySelect value={state.smtpSecurity} onChange={(value) => set("smtpSecurity", value)} />
        </Field>
      </div>

      <Field label="Username">
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
        <Field label={state.smtpDiffers ? "IMAP password" : "Password"}>
          <Input
            type="password"
            value={state.password}
            onChange={(e) => set("password", e.target.value)}
            autoComplete="new-password"
            placeholder={isEdit ? "Leave blank to keep the stored password" : ""}
          />
        </Field>
        {state.smtpDiffers && (
          <Field label="SMTP password">
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
        <Field label="Sent folder">
          <Input value={state.sentFolder} onChange={(e) => set("sentFolder", e.target.value)} />
        </Field>
        <Field label="Backfill">
          <Select value={state.backfill} onValueChange={(value) => set("backfill", value)}>
            <SelectTrigger>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
    </label>
  );
}

function SecuritySelect({ value, onChange }: { value: MailSecurity; onChange: (value: MailSecurity) => void }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as MailSecurity)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="tls">TLS</SelectItem>
        <SelectItem value="starttls">STARTTLS</SelectItem>
      </SelectContent>
    </Select>
  );
}
