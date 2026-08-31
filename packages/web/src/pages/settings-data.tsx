import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { MAX_PASSPHRASE_LENGTH } from "@conduit/shared";
import {
  useBackupPreflight, useDownloadBackup, useDownloadExport, useReauth,
} from "../queries";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from "../components/ui/dialog";
import {
  EMPTY_BACKUP_FORM, backupFormProblem, canSubmitBackup, downloadProblem,
  formatBytes, formatDuration, preflightSeverity, preflightWarning,
} from "./settings-data-lib";
import type { BackupFormState } from "./settings-data-lib";

/**
 * SETTINGS -> EXPORT AND BACKUP. Phase 7.6 Task 3.
 *
 * THE PAGE'S JOB IS TO STOP SOMEBODY CONFUSING THE TWO ARTEFACTS, and that is a
 * written requirement of the spec rather than a matter of layout. Two
 * similar-looking buttons is exactly how a person ends up with three years of
 * tidy CSV exports and no way to put Conduit back -- so each button carries its
 * purpose AND its limitation, in plain words, immediately beside it. Not in a
 * tooltip. Not in a help article. The limitation is not the small print here;
 * it is half the point of the page.
 *
 *   EXPORT is readable and portable and CANNOT be restored.
 *   BACKUP is exact and encrypted and CANNOT be read.
 *
 * FOUR THINGS ON THIS PAGE ARE REQUIREMENTS RATHER THAN STYLING, each written
 * beside the code that implements it:
 *
 *   1. RE-AUTHENTICATION before either download (ReauthDialog, and the gate on
 *      the server that is the actual control -- routes/reauth.ts).
 *   2. Both downloads issued with fetch() and a blob, never a link (api.ts's
 *      downloadArchive).
 *   3. The pre-flight warning before a long backup (PreflightNotice), the half
 *      of Chris's 31 Aug ruling that conf/nginx.conf cannot make.
 *   4. A passphrase carrying a line break refused HERE, with the reason, rather
 *      than silently truncated by 7z into an archive nobody can open.
 *
 * AND THE LOADING/EMPTY/ERROR PATTERN v1.2.2 SETTLED ON, which on this page
 * mostly means one negative rule: no control is ever disabled for a reason
 * nobody can see. Every disabled state on this page has a sentence next to it
 * saying why, and the one thing that could have gone wrong quietly -- the
 * pre-flight failing to load -- deliberately does NOT disable anything, because
 * the server's own pre-flight is the control and this page's copy is only the
 * warning.
 */

/** Which download a re-authentication prompt was opened for. */
type Pending = "export" | "backup";

export function SettingsDataPage() {
  const preflight = useBackupPreflight();
  const reauth = useReauth();
  const exportDownload = useDownloadExport();
  const backupDownload = useDownloadBackup();

  const [form, setForm] = useState<BackupFormState>(EMPTY_BACKUP_FORM);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const busy = reauth.isPending || exportDownload.isPending || backupDownload.isPending;
  const formProblem = backupFormProblem(form, touched);
  const backupReady = canSubmitBackup(form);

  function openPrompt(which: Pending) {
    setProblem(null);
    setDone(null);
    setPassword("");
    setPending(which);
  }

  function closePrompt() {
    setPending(null);
    // THE PASSWORD DOES NOT SURVIVE THE DIALOG. It is a React state string
    // either way, but leaving it set would keep it in the component for as long
    // as the page is open, and there is no reason for it to outlive the request
    // it was typed for.
    setPassword("");
  }

  async function confirmAndDownload(event: FormEvent) {
    event.preventDefault();
    const which = pending;
    if (which === null) return;
    setProblem(null);
    try {
      // ONE TICKET, ONE ARCHIVE. The ticket is minted here and spent by the
      // very next call; it is never held in state, so there is nothing on this
      // page for a second click to reuse.
      const { ticket } = await reauth.mutateAsync(password);
      closePrompt();
      const filename = which === "export"
        ? await exportDownload.mutateAsync(ticket)
        : await backupDownload.mutateAsync({ ticket, passphrase: form.passphrase });
      setDone(filename);
      if (which === "backup") {
        // The passphrase is cleared once the archive it protects has been
        // written. Keeping it in the form would leave it on screen behind a
        // dot mask for as long as the tab is open.
        setForm(EMPTY_BACKUP_FORM);
        setTouched(false);
      }
    } catch (error) {
      // Closed on EVERY path, including this one: a failure that left the
      // dialog open with the password still in it would invite a second try
      // against a throttle the person cannot see.
      closePrompt();
      setProblem(downloadProblem(error));
    }
  }

  return (
    <SettingsLayout>
      <div data-testid="data-settings" className="flex max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Export and backup</h2>
          {/*
            THE SENTENCE THE WHOLE PAGE EXISTS FOR, in the second person. The
            spec's own wording is "two similar-looking buttons is exactly how
            someone ends up with three years of tidy CSV exports and no way to
            put Conduit back"; this is that said to the person about to press
            one of them.
          */}
          <p data-testid="data-lead" className="text-sm text-slate-600">
            Two downloads that look alike and are not. An export is readable and cannot be
            restored. A backup can be restored and cannot be read. Three years of tidy CSV
            exports is not a way to put Conduit back -- only a backup is. Take both, and
            keep both.
          </p>
        </div>

        {problem !== null && (
          <p role="alert" data-testid="data-error" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {problem}
          </p>
        )}
        {done !== null && (
          <p data-testid="data-done" className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            Downloaded {done}.
          </p>
        )}

        <ExportCard
          busy={busy}
          running={exportDownload.isPending}
          onDownload={() => { openPrompt("export"); }}
        />

        <BackupCard
          form={form}
          formProblem={formProblem}
          ready={backupReady}
          busy={busy}
          running={backupDownload.isPending}
          preflight={preflight}
          onChange={(next) => { setTouched(true); setDone(null); setForm(next); }}
          onDownload={() => { setTouched(true); openPrompt("backup"); }}
        />

        {/*
          NOT A REPLACEMENT FOR `yunohost backup`, said on the page and not only
          in the docs, because the Settings page is where somebody forms the
          belief that their server is backed up.
        */}
        <div data-testid="data-yunohost" className="rounded-md border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
          <p className="font-semibold text-slate-800">This does not replace yunohost backup.</p>
          <p className="mt-1">
            What is here backs up Conduit&apos;s data. YunoHost still owns the nginx
            configuration, the systemd unit and the app registration. Restoring a Conduit
            backup onto a server with no Conduit installed will not give you a working
            site, and restoring a YunoHost backup of an app whose data you have lost will
            not give you your deals back. They are two different jobs and you want both.
          </p>
        </div>

        <ReauthDialog
          pending={pending}
          password={password}
          busy={busy}
          onPassword={setPassword}
          onCancel={closePrompt}
          onSubmit={(event) => { void confirmAndDownload(event); }}
        />
      </div>
    </SettingsLayout>
  );
}

/** One download and everything said about it, so the two cards cannot drift apart. */
function Card({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="flex flex-col gap-3 rounded-md border border-slate-200 p-4">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The limitation, rendered so it cannot be skimmed past.
 *
 * A SHARED COMPONENT RATHER THAN TWO PARAGRAPHS, because the requirement is
 * symmetric: each artefact states what it CANNOT do, in the same place, in the
 * same weight. Two hand-written paragraphs would be one edit away from one
 * being softened.
 */
function Limitation({ testId, headline, children }: {
  testId: string; headline: string; children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="font-semibold">{headline}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}

function ExportCard(
  { busy, running, onDownload }: { busy: boolean; running: boolean; onDownload: () => void },
) {
  return (
    <Card title="Export -- the readable half" testId="export-card">
      <p className="text-sm text-slate-600">
        A ZIP holding one CSV per record type -- companies, contacts, deals, projects,
        tasks, notes, meetings and documents -- plus every file you have uploaded and
        every quote PDF you have issued. The CSVs open in Excel, Numbers or LibreOffice,
        accented names intact.
      </p>
      <Limitation testId="export-limitation" headline="It cannot be restored into Conduit.">
        There is no database dump in it, no mail, and no passwords, so nothing can rebuild
        an install from it. It is for reading your data, for moving it somewhere else, and
        for keeping a copy you will still be able to open in ten years. If you want to be
        able to put Conduit back, take a backup as well.
      </Limitation>
      <p className="text-xs text-slate-500">
        No passphrase, because there is nothing in it that encryption would be protecting:
        no credentials, no mail messages, and not the key your mail passwords are
        encrypted with. Archived records are included, with the date they were archived.
      </p>
      <div className="flex items-center justify-end gap-3">
        {/*
          THE REASON THE BUTTON IS OFF, BESIDE THE BUTTON. Only one archive is
          built at a time -- a memory decision for the export and a disk one for
          the backup -- so while either is running BOTH buttons are disabled.
          When it is THIS one running the label says so; when it is the other,
          nothing on this card would otherwise explain the dead button.
        */}
        {busy && !running && (
          <span data-testid="export-blocked" className="text-xs text-slate-500">
            One download at a time. This is waiting for the other one.
          </span>
        )}
        <Button data-testid="export-download" disabled={busy} onClick={onDownload}>
          {running ? "Working..." : "Download export"}
        </Button>
      </div>
    </Card>
  );
}

/**
 * WHERE THE PASSPHRASE IS TYPED, AND WHERE IT IS SAID THAT IT CANNOT BE
 * RECOVERED -- above the field, before the first backup, which is the spec's
 * word and not a preference. Saying it afterwards would be a receipt for a
 * mistake rather than a warning about one.
 */
function BackupCard(props: {
  form: BackupFormState;
  formProblem: string | null;
  ready: boolean;
  busy: boolean;
  running: boolean;
  preflight: ReturnType<typeof useBackupPreflight>;
  onChange: (next: BackupFormState) => void;
  onDownload: () => void;
}) {
  const { form, formProblem, ready, busy, running, preflight, onChange, onDownload } = props;
  return (
    <Card title="Backup -- the exact half" testId="backup-card">
      <p className="text-sm text-slate-600">
        An AES-256 encrypted .7z: a full dump of the database, every stored file and quote
        PDF, every mail message, and the key your stored mail passwords are encrypted
        with. This is the artefact a restore reads, and it is the only one that can put
        this install back as it was.
      </p>
      <Limitation testId="backup-limitation" headline="It is not readable in a spreadsheet.">
        Being exact means one database.sql file rather than a folder of CSVs, and the
        files inside are named by their checksum rather than by Invoice.pdf. Nothing in it
        is meant to be read by eye. If you want to look at your data, take an export --
        that is the half of this page that exists for it.
      </Limitation>
      <Limitation testId="backup-credentials" headline="A backup is a credential store.">
        It carries the key your mail passwords are encrypted with, and every one of those
        passwords, and it lands in your Downloads folder like any other file. The
        encryption is what makes that acceptable, which is why it is not optional and
        there is no way to ask for an unencrypted one.
      </Limitation>

      <PreflightNotice preflight={preflight} />

      {/*
        THE NO-RECOVERY WARNING, BEFORE THE FIELD. It is above the input in the
        DOM as well as on the screen, so a screen reader reaches it first.
      */}
      <div data-testid="backup-no-recovery" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        <p className="font-semibold">There is no way to recover this passphrase.</p>
        <p className="mt-1">
          Conduit never stores it, never logs it and never writes it to disk. If you lose
          it, the backup is a file of random bytes and nobody -- not you, not Conduit, not
          anyone with access to the server -- can open it. That is exactly what makes the
          file safe to keep in cloud storage, and it is not adjustable. Write it down
          somewhere that is not this computer before you press the button.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Passphrase
          <Input
            type="password"
            value={form.passphrase}
            maxLength={MAX_PASSPHRASE_LENGTH}
            autoComplete="new-password"
            disabled={busy}
            data-testid="backup-passphrase"
            onChange={(event) => { onChange({ ...form, passphrase: event.target.value }); }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Passphrase again
          <Input
            type="password"
            value={form.repeat}
            maxLength={MAX_PASSPHRASE_LENGTH}
            autoComplete="new-password"
            disabled={busy}
            data-testid="backup-passphrase-repeat"
            onChange={(event) => { onChange({ ...form, repeat: event.target.value }); }}
          />
        </label>
      </div>
      <p className="text-xs text-slate-400">
        Anything printable, up to {MAX_PASSPHRASE_LENGTH} characters. Spaces count, at
        either end. A long phrase you will remember beats a short one you will not: this
        archive stretches what you type about 524,000 times before using it, which is what
        makes a typed passphrase worth having.
      </p>
      {/*
        THE REFUSAL AND ITS REASON. A line break cannot normally be typed into a
        single-line field, but it can arrive from a password manager or a paste,
        and 7z would take everything before it and report success -- an archive
        encrypted with something other than what was typed, with no recovery
        path. Refusing it mutely would be worse than not refusing it.
      */}
      {formProblem !== null && (
        <p role="alert" data-testid="backup-form-problem" className="text-sm text-red-600">
          {formProblem}
        </p>
      )}

      <SevenZipTools />

      <div className="flex items-center justify-end gap-3">
        {/*
          NO CONTROL DISABLED FOR A REASON NOBODY CAN SEE. When the button is
          off because the form is not finished, this says so beside it -- and
          `formProblem` above says which part.
        */}
        {!ready && !busy && (
          <span data-testid="backup-blocked" className="text-xs text-slate-500">
            Fill in both passphrase fields to enable this.
          </span>
        )}
        {busy && !running && (
          <span data-testid="backup-waiting" className="text-xs text-slate-500">
            One download at a time. This is waiting for the other one.
          </span>
        )}
        <Button data-testid="backup-download" disabled={busy || !ready} onClick={onDownload}>
          {running ? "Working..." : "Download backup"}
        </Button>
      </div>
    </Card>
  );
}

/**
 * WHAT OPENS A .7z, ON THE PAGE RATHER THAN IN A DOCUMENT NOBODY FINDS.
 *
 * The format was chosen so that a backup opens by double-clicking it and typing
 * the passphrase -- Chris's requirement, and the reason it is a .7z and not two
 * openssl commands. That requirement is only met if the person knows which
 * program to have, and on a Mac there is a one-time install standing between
 * them and it.
 *
 * THE MAC LINE IS MEASURED, and the measurement is narrower than the obvious
 * claim. macOS's Archive Utility DOES list org.7-zip.7-zip-archive among the
 * types it handles, and it does extract an ordinary .7z. Given this format --
 * AES-256 with encrypted headers -- it produces nothing at all. Measured on
 * macOS 26.5.2: the same archive unencrypted extracted to database.sql, and the
 * encrypted one left the folder untouched. So the honest sentence is not "it
 * does not do .7z"; it is that it will not open an ENCRYPTED one, which is the
 * only kind Conduit writes.
 */
function SevenZipTools() {
  return (
    <div data-testid="backup-tools" className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
      <p className="font-semibold text-slate-800">Opening one</p>
      <dl className="flex flex-col gap-1">
        <div>
          <dt className="inline font-medium text-slate-700">Windows: </dt>
          <dd className="inline">
            7-Zip, free from 7-zip.org. Right-click the file, then 7-Zip, then Extract
            Here, and type the passphrase.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Mac: </dt>
          <dd className="inline">
            Keka, free from keka.io. macOS&apos;s built-in Archive Utility will not open an
            encrypted archive -- it extracts an ordinary .7z and produces nothing at all
            for this one -- so this is a one-time install, and double-clicking without it
            fails without ever asking for a passphrase.
          </dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Linux: </dt>
          <dd className="inline">
            Ark or File Roller, whichever your desktop ships, or 7z x on the command line
            (apt install p7zip-full).
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * HOW LONG THIS WILL TAKE, BEFORE IT IS STARTED.
 *
 * The backup cannot stream -- the whole archive is built before the first byte
 * of the response -- so from a browser a long backup and a hung one look
 * identical. conf/nginx.conf raises what the proxy will wait for; this is the
 * other half of Chris's 31 Aug ruling, and it is the half a timeout cannot
 * make: somebody deciding whether to start.
 *
 * THE FAILURE MODE OF THIS COMPONENT IS DELIBERATELY HARMLESS. If the estimate
 * cannot be fetched, it says so and disables nothing: the server runs its own
 * disk pre-flight before spawning anything, so this page's copy is a warning
 * and never the control. A page that greyed out the backup button because a
 * secondary request failed would be exactly the shape this codebase keeps
 * refusing to ship.
 */
function PreflightNotice({ preflight }: { preflight: ReturnType<typeof useBackupPreflight> }) {
  if (preflight.isLoading) {
    return <p data-testid="backup-preflight-loading" className="text-xs text-slate-400">Checking how long this will take...</p>;
  }
  if (preflight.error !== null) {
    return (
      <p role="alert" data-testid="backup-preflight-error" className="text-xs text-amber-700">
        Could not work out how big this backup would be ({preflight.error.message}). You
        can still take one -- the server checks the disk itself before it starts.
      </p>
    );
  }
  const data = preflight.data;
  if (data === undefined) return null;

  const warning = preflightWarning(data);
  const severity = preflightSeverity(data);
  const size = formatBytes(data.databaseBytes + data.blobBytes);

  if (warning === null || severity === null) {
    return (
      <p data-testid="backup-preflight" className="text-xs text-slate-500">
        About {size} to archive, roughly {formatDuration(data.estimatedSeconds)}. Nothing
        downloads until the whole archive is finished.
      </p>
    );
  }
  const tone = severity === "blocking"
    ? "border-red-200 bg-red-50 text-red-800"
    : severity === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <p
      role={severity === "note" ? undefined : "alert"}
      data-testid="backup-preflight-warning"
      data-severity={severity}
      className={`rounded-md border px-3 py-2 text-xs ${tone}`}
    >
      {warning}
    </p>
  );
}

/**
 * RE-AUTHENTICATION, AND WHY THIS DIALOG IS NOT THE CONTROL.
 *
 * The control is on the server: POST /api/reauth checks the password against
 * YunoHost's own portal API and mints a single-use ticket, and both download
 * routes refuse without one. This is the part a person sees. A dialog alone
 * would stop nobody -- the endpoints are one fetch away, and somebody who has
 * walked up to an unlocked session is not going to use the page.
 *
 * WHY IT EXISTS AT ALL: 7.6 turns a stolen or borrowed session into a one-click
 * copy of the entire CRM, and for the backup, of the mail key and every stored
 * mail password with it. YunoHost has no second factor -- measured on the
 * deploy target -- so the session cookie is the whole perimeter, and this is
 * the one place a password is asked for again.
 */
function ReauthDialog(props: {
  pending: Pending | null;
  password: string;
  busy: boolean;
  onPassword: (value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const { pending, password, busy, onPassword, onCancel, onSubmit } = props;
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent data-testid="reauth-dialog">
        <DialogTitle>Confirm your password</DialogTitle>
        <DialogDescription>
          {pending === "backup"
            ? "This download carries the whole database, every stored file and every mail message, plus the key your mail passwords are encrypted with. Type your YunoHost password to confirm you are the one asking."
            : "This download carries every company, contact, deal, project and file in one file. Type your YunoHost password to confirm you are the one asking."}
        </DialogDescription>
        <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
            Your YunoHost password
            <Input
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              disabled={busy}
              data-testid="reauth-password"
              onChange={(event) => { onPassword(event.target.value); }}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="reauth-cancel" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-testid="reauth-confirm" disabled={busy || password === ""}>
              {busy ? "Checking..." : "Confirm and download"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
