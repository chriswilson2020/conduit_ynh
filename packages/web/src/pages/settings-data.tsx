import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { MAX_PASSPHRASE_LENGTH, destructiveEffects, planIsApplicable } from "@conduit/shared";
import type { RestoreInspection, RestoreOutcome } from "@conduit/shared";
import {
  applyRestore, cancelRestore, inspectRestore, requestReauthTicket,
  useBackupPreflight, useDownloadBackup, useDownloadExport,
} from "../queries";
// ApiError only, and only for the one place this page has to tell one refusal
// from another rather than print it: a cancel that answers "no such plan" has
// achieved what it was asked to. Every other failure on this page goes through
// settings-data-lib.ts, which is where the branching on `code` belongs.
import { ApiError } from "../api";
import { SettingsLayout } from "../components/settings-layout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from "../components/ui/dialog";
import {
  EMPTY_BACKUP_FORM, EMPTY_RESTORE_FORM, applyKeptThePreview, backupFormProblem,
  canPreviewRestore, canSubmitBackup, downloadProblem, formatBytes, formatDuration,
  planCountLabel, preflightSeverity, preflightWarning, restoreConfirmBlocked,
  restoreFormProblem, restorePreviewBlocked, restoreProblem,
} from "./settings-data-lib";
import type { BackupFormState, RestoreFormState } from "./settings-data-lib";

/**
 * SETTINGS -> EXPORT, BACKUP AND RESTORE. Phase 7.6 Task 3, and Phase 7.7's
 * restore surface.
 *
 * THE PAGE'S JOB IS TO STOP SOMEBODY CONFUSING THE ARTEFACTS, and that is a
 * written requirement of both specs rather than a matter of layout. Two
 * similar-looking buttons is exactly how a person ends up with three years of
 * tidy CSV exports and no way to put Conduit back -- so each carries its
 * purpose AND its limitation, in plain words, immediately beside it. Not in a
 * tooltip. Not in a help article. The limitation is not the small print here;
 * it is half the point of the page.
 *
 *   EXPORT is readable and portable and CANNOT be restored.
 *   BACKUP is exact and encrypted and CANNOT be read.
 *   RESTORE is neither of those. It is the other direction.
 *
 * THE THIRD ONE IS NOT A THIRD DOWNLOAD AND THE PAGE MUST NOT LET IT READ AS
 * ONE. 7.7's spec says in as many words that the Settings page must not let
 * somebody reach for one thing when they meant a restore, and the danger runs
 * the way round that a fourth button in a row of three would create: the two
 * above copy data OUT and cost nothing if pressed by mistake, and this one
 * destroys every row in the database. So it is a separate section, below a
 * rule, with its own heading, its own colour and a sequence -- upload, read a
 * preview, type the install's name, type a password twice -- that cannot be
 * completed by clicking in the same place twice.
 *
 * SIX THINGS ON THIS PAGE ARE REQUIREMENTS RATHER THAN STYLING, each written
 * beside the code that implements it:
 *
 *   1. RE-AUTHENTICATION before either download and before BOTH halves of a
 *      restore (ReauthDialog, and the gate on the server that is the actual
 *      control -- routes/reauth.ts).
 *   2. Both downloads issued with fetch() and a blob, never a link (api.ts's
 *      downloadArchive).
 *   3. The pre-flight warning before a long backup (PreflightNotice), the half
 *      of Chris's 31 Aug ruling that conf/nginx.conf cannot make.
 *   4. A passphrase carrying a line break refused HERE, with the reason, rather
 *      than silently truncated by 7z into an archive nobody can open.
 *   5. THE PREVIEW IS RENDERED, NEVER RECONSTRUCTED. RestorePlanCard prints
 *      what POST /api/restore/inspect answered and sends back an id. It does
 *      not re-derive a count, predict an effect or compose a sentence about
 *      what will happen -- @conduit/shared's plan.ts explains why at length,
 *      and the short version is that a preview which is a second
 *      implementation of apply is a preview that can disagree with it.
 *   6. THE RESTART ADVICE IS HONEST ABOUT HAVING NOTHING BEHIND IT. See
 *      RestartAdvice.
 *
 * AND THE LOADING/EMPTY/ERROR PATTERN v1.2.2 SETTLED ON, which on this page
 * mostly means one negative rule: no control is ever disabled for a reason
 * nobody can see. Every disabled state on this page has a sentence next to it
 * saying why, and the one thing that could have gone wrong quietly -- the
 * pre-flight failing to load -- deliberately does NOT disable anything, because
 * the server's own pre-flight is the control and this page's copy is only the
 * warning.
 */

/**
 * Which operation a re-authentication prompt was opened for.
 *
 * THE RESTORE IS TWO OF THEM AND THAT IS THE DESIGN RATHER THAN A LIMITATION.
 * A ticket is single-use (services/reauth.ts), so one cannot span a preview and
 * an apply with a person reading a destruction list in between -- and it should
 * not: what the gate proves is that the operator is at the keyboard NOW, and
 * the moment that matters is the one where the database goes, not the one two
 * minutes earlier when they started reading. The cost is that the page asks for
 * the password twice, so the page says why, twice: in the section's own copy
 * and again in each prompt.
 */
type Pending = "export" | "backup" | "restore-preview" | "restore-apply";

export function SettingsDataPage() {
  const preflight = useBackupPreflight();
  const exportDownload = useDownloadExport();
  const backupDownload = useDownloadBackup();

  const [form, setForm] = useState<BackupFormState>(EMPTY_BACKUP_FORM);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /**
   * The password check, tracked here rather than by a mutation.
   *
   * requestReauthTicket is a plain function precisely so the password does not
   * outlive the call -- see its own comment for the measurement that made it
   * one -- and the cost of that is one boolean. It is a small price for the
   * only copy of the password being the field state below, which closing the
   * prompt clears.
   */
  const [checking, setChecking] = useState(false);

  /**
   * THE RESTORE'S STATE, AND THE ONE PIECE OF IT THAT IS NOT HERE.
   *
   * `preview` is what the server answered -- the plan and the install's name --
   * held verbatim and never rebuilt. Everything the operator reads before
   * confirming comes out of this object, so there is nothing on this page that
   * could describe the work differently from the thing that will do it.
   *
   * THE PLAN ITSELF NEVER GOES BACK. Apply is addressed by `preview.plan.planId`
   * and carries no description of the work, which is what makes the object the
   * operator read and the object the server applies the same one.
   *
   * `installName` IS KEPT SEPARATELY AND OUTLIVES THE PREVIEW, because the
   * restart advice after a successful restore names the systemd unit, and under
   * YunoHost the unit, the system user and the database all carry the install's
   * name. Clearing it with the preview would leave the one instruction the
   * operator still has to follow with a blank in it.
   */
  const [restoreForm, setRestoreForm] = useState<RestoreFormState>(EMPTY_RESTORE_FORM);
  const [restoreTouched, setRestoreTouched] = useState(false);
  const [preview, setPreview] = useState<RestoreInspection | null>(null);
  const [installName, setInstallName] = useState<string | null>(null);
  const [typedName, setTypedName] = useState("");
  /**
   * THE ARCHIVE PASSPHRASE, ASKED FOR A SECOND TIME AT THE CONFIRMATION.
   *
   * IT IS NOT CARRIED OVER FROM THE UPLOAD FORM, and that is a decision rather
   * than an oversight. Keeping it would remove a retype and would mean the
   * archive's passphrase sitting in this component for however long somebody
   * spends reading a destruction list -- against 7.6's rule that a passphrase
   * does not outlive the request it was typed for. The retype is also the thing
   * routes/restore.ts's passphrase proof exists to check: apply needs the
   * plaintext to encrypt the safety backup, and a safety backup written under a
   * string the operator has never successfully used would be no undo at all.
   * Mistyping it costs a clean 400 and leaves the upload where it is.
   */
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RestoreOutcome | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  /**
   * ONE OPERATION AT A TIME ACROSS ALL FOUR, and the reason is the same one
   * 7.6 gave for the two downloads: they contend for the same disk. A restore
   * preview writes an upload into $data_dir and unpacks it there, which is the
   * same disk a backup is being built on. The server enforces its own
   * single-flight per route; this is what stops the page offering a button that
   * would meet a legitimate 503, and every control that goes dark because of it
   * says so beside itself.
   */
  const busy = checking || exportDownload.isPending || backupDownload.isPending
    || previewing || applying || cancelling;
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

  /**
   * The one submit handler behind the one prompt, dispatching on what it was
   * opened for.
   *
   * ONE DIALOG RATHER THAN THREE, because the thing being asked for is
   * identical in all four cases -- the operator's YunoHost password -- and
   * three dialogs would be three places for the field to stop being cleared on
   * the failing path. What differs is the sentence above the field and what
   * happens with the ticket, and both of those are switched on `pending`.
   */
  async function confirmPrompt(event: FormEvent) {
    event.preventDefault();
    switch (pending) {
      case "export":
      case "backup":
        await confirmAndDownload(event, pending);
        return;
      case "restore-preview":
        await confirmAndPreview(event);
        return;
      case "restore-apply":
        await confirmAndApply(event);
        return;
      case null:
        return;
    }
  }

  async function confirmAndDownload(event: FormEvent, which: "export" | "backup") {
    event.preventDefault();
    setProblem(null);
    setChecking(true);
    try {
      // ONE TICKET, ONE ARCHIVE. The ticket is minted here and spent by the
      // very next call; it is never held in state, so there is nothing on this
      // page for a second click to reuse. The password is a local const and an
      // argument, and nothing keeps a copy of either.
      const { ticket } = await requestReauthTicket(password);
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
    } finally {
      setChecking(false);
    }
  }

  /**
   * THE FIRST HALF: upload the archive and read back what a restore WOULD do.
   *
   * NOTHING IS DESTROYED HERE, and the copy says so. What IS done is that the
   * archive is decrypted onto the server's disk for the life of the preview,
   * which is why the plan card offers a Cancel that deletes it rather than
   * leaving it to the half-hour expiry.
   */
  async function confirmAndPreview(event: FormEvent) {
    event.preventDefault();
    const file = restoreForm.file;
    if (file === null) return;
    setRestoreError(null);
    setOutcome(null);
    setChecking(true);
    try {
      const { ticket } = await requestReauthTicket(password);
      closePrompt();
      setChecking(false);
      setPreviewing(true);
      const answer = await inspectRestore({
        ticket, file, passphrase: restoreForm.passphrase,
      });
      setPreview(answer);
      setInstallName(answer.installName);
      // THE PASSPHRASE IS CLEARED THE MOMENT IT HAS BEEN USED, for the reason
      // the backup form's is: there is no reason for it to outlive the request
      // it was typed for, and the confirmation below asks for it again on
      // purpose.
      //
      // THE FILE IS NOT CLEARED, AND THAT IS A FIX RATHER THAN AN OMISSION. A
      // file input is uncontrolled -- React cannot empty one by re-rendering --
      // so clearing this half of the state would leave the chosen filename on
      // screen with `file: null` behind it, and after a Cancel the operator
      // would be told to "choose a backup file" while looking at the name of
      // the one they chose. That is precisely the disabled-control-with-an
      // -invisible-reason this page exists not to ship. Keeping it also means a
      // cancelled preview can be retried without finding the file again, and it
      // costs nothing: the archive is encrypted and the secret that opens it is
      // the line above.
      setRestoreForm((current) => ({ ...current, passphrase: "" }));
      // Untouched again, so the upload card does not greet a returning operator
      // with a red "type a passphrase" for a form they have not come back to
      // yet. The button is still off, and restorePreviewBlocked says why.
      setRestoreTouched(false);
      setTypedName("");
      setConfirmPassphrase("");
    } catch (error) {
      closePrompt();
      setRestoreError(restoreProblem(error, "preview"));
      // THE PASSPHRASE GOES ON THE FAILING PATH TOO, and a review found it
      // staying. The rule this field's own comment states is that a passphrase
      // does not outlive the request it was typed for, and a refused archive is
      // a request that is over. The file is kept, so a second try is a retype
      // rather than a re-choose.
      setRestoreForm((current) => ({ ...current, passphrase: "" }));
      setRestoreTouched(false);
    } finally {
      setChecking(false);
      setPreviewing(false);
    }
  }

  /**
   * THE SECOND HALF: destroy this install's database and put the backup in its
   * place.
   *
   * A REFUSED CONFIRMATION LEAVES THE PREVIEW WHERE IT IS, and that is the
   * whole reason applyKeptThePreview exists. routes/restore.ts orders its
   * guards so that everything which can refuse without consuming anything runs
   * first -- so a mistyped name, a mistyped passphrase, a wrong password or a
   * write gate that would not drain all leave the operator with their upload
   * and a second try rather than a three-gigabyte re-upload. Throwing the
   * preview away on their behalf would take that away.
   */
  async function confirmAndApply(event: FormEvent) {
    event.preventDefault();
    const held = preview;
    if (held === null) return;
    setRestoreError(null);
    setChecking(true);
    try {
      const { ticket } = await requestReauthTicket(password);
      closePrompt();
      setChecking(false);
      setApplying(true);
      const result = await applyRestore({
        ticket,
        planId: held.plan.planId,
        passphrase: confirmPassphrase,
        confirmName: typedName,
      });
      setOutcome(result);
      // The preview is gone on the server the moment apply took it, so the page
      // stops offering it. The install's name is kept -- the restart advice
      // below names the systemd unit with it.
      setPreview(null);
      setTypedName("");
      setConfirmPassphrase("");
    } catch (error) {
      closePrompt();
      setRestoreError(restoreProblem(error, "apply"));
      if (!applyKeptThePreview(error)) {
        // The server consumed the plan, or nobody can say whether it did. Either
        // way the id will not resolve again, so the page must not leave a button
        // pointing at it -- a second press would answer 404 and read as a
        // second, different failure. The passphrase goes with it.
        setPreview(null);
        setTypedName("");
      }
      setConfirmPassphrase("");
    } finally {
      setChecking(false);
      setApplying(false);
    }
  }

  /**
   * Throw the preview away now rather than in half an hour.
   *
   * WHAT THIS DELETES IS A DECRYPTED BACKUP. The staged archive holds mail.key
   * in the clear and every stored mail password, and it sits in $data_dir until
   * the plan expires. An operator who has changed their mind should not have to
   * wait out a timer for that, which is why the route exists and why this
   * button is offered rather than left to the TTL.
   *
   * A 404 IS A SUCCESS HERE. The plan expiring between the render and the click
   * means the thing this was going to delete is already gone, and reporting
   * that as a failure would be telling somebody to worry about the outcome they
   * asked for.
   *
   * A FAILED CANCEL KEEPS THE CARD, AND A REVIEW IS WHY. This used to clear the
   * preview in a `finally`, so any failure that was not a 404 threw away the
   * only thing that could reach the staged archive -- and the failure is not
   * hypothetical: DELETE is a write method, so app.ts's write gate refuses it
   * with 503 for the whole of any restore that happens to be running. The state
   * that left behind is the worst one this surface can produce: a decrypted
   * backup sitting in $data_dir for the rest of its half hour, `intakeSessions`
   * still holding it, every new preview answered with "another backup is
   * already uploaded and waiting for a decision; apply or cancel it first" --
   * and no Cancel button anywhere, because the page had just removed it.
   */
  async function discardPreview() {
    const held = preview;
    if (held === null) return;
    setRestoreError(null);
    setCancelling(true);
    try {
      await cancelRestore(held.plan.planId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "restore_plan_unknown") {
        // NAMES THIS REQUEST rather than borrowing the preview's words, which
        // told the operator to try something that was not what had failed.
        setRestoreError(
          `The upload could not be deleted, so it is still on the server: `
          + `${restoreProblem(error, "preview")} Nothing has been restored. `
          + `Try Cancel again in a moment; if it keeps failing the upload is `
          + `deleted on its own when this preview expires.`,
        );
        setCancelling(false);
        return;
      }
    }
    setPreview(null);
    setTypedName("");
    setConfirmPassphrase("");
    setCancelling(false);
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
            THE LAST SENTENCE ARRIVED WITH 7.7 and it is a prose sweep rather
            than a flourish: this paragraph said "two downloads" on a page that
            now has a third thing on it, and 7.7's spec is explicit that nobody
            may reach for the wrong one. It points DOWN the page rather than
            describing the restore here, because the restore's own section is
            where it is explained and this is a paragraph about the two things
            above it.
          */}
          <p data-testid="data-lead" className="text-sm text-slate-600">
            Two downloads that look alike and are not. An export is readable and cannot be
            restored. A backup can be restored and cannot be read. Three years of tidy CSV
            exports is no way to put Conduit back -- only a backup is. Take both, and keep
            both. Putting one back is further down this page, and it is not a download: it
            destroys everything that is here now.
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

        <RestoreSection
          form={restoreForm}
          formProblem={restoreFormProblem(restoreForm, restoreTouched)}
          blocked={restorePreviewBlocked(restoreForm, busy, previewing)}
          busy={busy}
          previewing={previewing}
          applying={applying}
          cancelling={cancelling}
          preview={preview}
          installName={installName}
          typedName={typedName}
          confirmPassphrase={confirmPassphrase}
          error={restoreError}
          outcome={outcome}
          onChange={(next) => { setRestoreTouched(true); setRestoreForm(next); }}
          onPreview={() => { setRestoreTouched(true); openPrompt("restore-preview"); }}
          onTypedName={setTypedName}
          onConfirmPassphrase={setConfirmPassphrase}
          onApply={() => { openPrompt("restore-apply"); }}
          onDiscard={() => { void discardPreview(); }}
        />

        {/*
          NOT A REPLACEMENT FOR `yunohost backup`, said on the page and not only
          in the docs, because the Settings page is where somebody forms the
          belief that their server is backed up.
          THE THIRD SENTENCE ARRIVED WITH 7.7, and it is a prose sweep: this
          block was written when the page could only produce a backup, so it
          spoke of restoring as something done elsewhere. Now the page does it,
          and the boundary has to be drawn in the direction the page can act in.
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
          <p className="mt-1">
            The restore above is the same boundary from the other side: it runs inside a
            Conduit that is already installed and already answering, and it replaces that
            install&apos;s data. It cannot install Conduit, it cannot repair a server that
            will not boot, and it is not what you reach for when the site is not there at
            all. That is <code>yunohost backup</code>&apos;s job, and then this one
            afterwards.
          </p>
        </div>

        <ReauthDialog
          pending={pending}
          password={password}
          busy={busy}
          onPassword={setPassword}
          onCancel={closePrompt}
          onSubmit={(event) => { void confirmPrompt(event); }}
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
        <DialogTitle>
          {pending === "restore-apply" ? "Confirm your password to destroy this database"
            : "Confirm your password"}
        </DialogTitle>
        {/*
          THE SENTENCE SAYS WHAT THIS PARTICULAR PASSWORD IS BUYING, and for the
          restore it also says why it is being asked TWICE. That is not padding:
          a second prompt with no explanation reads as a bug or as suspicion,
          and an operator who thinks a prompt is a glitch is an operator who
          stops reading prompts.
        */}
        <DialogDescription>
          {/*
            THE TESTID IS ON A SPAN INSIDE, NOT ON DialogDescription, AND A
            FAILING TEST IS WHAT FOUND THAT IT HAD TO BE. That component takes
            `{ children }` and nothing else, so any other prop is dropped -- and
            TypeScript does not catch it, because it skips excess-property
            checking for a JSX attribute whose name is not a valid identifier,
            which `data-testid` is not. So it compiled, rendered, and had no
            testid on it. Wrapping the text is the narrow fix; widening a shared
            dialog primitive for one caller is not.
          */}
          <span data-testid="reauth-reason">{reauthReason(pending)}</span>
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
            <Button
              type="submit"
              // THE ONE PLACE ON THIS PAGE WHERE THE DIALOG ITSELF CHANGES
              // COLOUR. Everything else here downloads a file; this press
              // destroys a database, and the control that starts it should not
              // look like the control that saved a spreadsheet a minute ago.
              variant={pending === "restore-apply" ? "danger" : "default"}
              data-testid="reauth-confirm"
              disabled={busy || password === ""}
            >
              {busy ? "Checking..." : reauthConfirmLabel(pending)}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * WHY THIS PARTICULAR PASSWORD IS BEING ASKED FOR, and for the restore, WHY
 * TWICE.
 *
 * A function rather than four strings inline, so that the two restore
 * sentences sit next to each other and cannot be edited into agreeing about
 * the wrong thing. They are the page's account of the design decision recorded
 * in this file's `Pending` type and, at length, in routes/restore.ts's apply
 * handler: a ticket is single-use, so one cannot span a preview and an apply --
 * and it should not, because what it proves is that the operator is at the
 * keyboard NOW.
 */
function reauthReason(pending: Pending | null): string {
  switch (pending) {
    case "backup":
      return "This download carries the whole database, every stored file and every mail "
        + "message, plus the key your mail passwords are encrypted with. Type your YunoHost "
        + "password to confirm you are the one asking.";
    case "restore-preview":
      return "Conduit will open this archive on the server and show you exactly what "
        + "restoring it would do. Nothing is changed and nothing is destroyed by this step. "
        + "You will be asked for this password once more, at the moment the database is "
        + "actually replaced: a password confirmation is good for one request and cannot be "
        + "carried forward, because what it proves is that you are at the keyboard now.";
    case "restore-apply":
      return "This is the one that destroys. Every row in this install's database is dropped "
        + "and the backup's data is put in its place, and the only way back is the safety "
        + "backup Conduit writes first. You are asked again because the confirmation you gave "
        + "for the preview was spent on the preview -- and because the moment worth proving "
        + "you are here for is this one, not the one you read the list in.";
    case "export":
    case null:
      return "This download carries every company, contact, deal, project and file in one "
        + "file. Type your YunoHost password to confirm you are the one asking.";
  }
}

/** What the prompt's submit button says it will do. */
function reauthConfirmLabel(pending: Pending | null): string {
  switch (pending) {
    case "restore-preview": return "Confirm and preview";
    case "restore-apply": return "Confirm and restore";
    case "export":
    case "backup":
    case null:
      return "Confirm and download";
  }
}

/**
 * SETTINGS -> RESTORE. Phase 7.7's surface.
 *
 * A SECTION AND NOT A THIRD CARD, and that is the requirement rather than the
 * styling. 7.6's page is two cards in a column, each with a button on the
 * right; a third one shaped the same way would put "destroy this database"
 * one careless click away from "download a spreadsheet", which is precisely
 * what 7.7's spec forbids. So this is separated by a rule, headed on its own,
 * bordered in red rather than slate, and -- more to the point than any of that
 * -- it CANNOT BE COMPLETED BY PRESSING ONE THING. Upload, a password, a
 * preview to read, the install's name typed out, the archive passphrase again,
 * a second password. Every one of those steps exists for a reason stated beside
 * it.
 */
function RestoreSection(props: {
  form: RestoreFormState;
  formProblem: string | null;
  blocked: string | null;
  busy: boolean;
  previewing: boolean;
  applying: boolean;
  cancelling: boolean;
  preview: RestoreInspection | null;
  installName: string | null;
  typedName: string;
  confirmPassphrase: string;
  error: string | null;
  outcome: RestoreOutcome | null;
  onChange: (next: RestoreFormState) => void;
  onPreview: () => void;
  onTypedName: (value: string) => void;
  onConfirmPassphrase: (value: string) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const {
    form, formProblem, blocked, busy, previewing, applying, cancelling, preview,
    installName, typedName, confirmPassphrase, error, outcome,
    onChange, onPreview, onTypedName, onConfirmPassphrase, onApply, onDiscard,
  } = props;

  return (
    <section
      data-testid="restore-section"
      className="flex flex-col gap-4 rounded-md border-2 border-red-200 bg-red-50/40 p-4"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-red-900">Restore -- putting a backup back</h2>
        {/*
          THE PARAGRAPH THAT MAKES THIS DIFFERENT IN KIND. The two things above
          copy data OUT and cost nothing if pressed by mistake. This one is the
          other direction and it is not recoverable by pressing it again.
        */}
        <p data-testid="restore-lead" className="text-sm text-red-900">
          The two above take data out of Conduit. This one puts a backup in, and the way it
          does that is by destroying everything that is here first. It is not a third
          download and it does not behave like one: there is a preview you have to read, this
          install&apos;s name to type out, and your password twice.
        </p>
      </div>

      {/*
        THE LIMITATION, in the same component and the same weight the export and
        the backup state theirs in. The requirement is symmetric: each artefact
        says what it CANNOT do, in the same place, in the same voice.
      */}
      <Limitation
        testId="restore-limitation"
        headline="It replaces everything, and there is nothing selective about it."
      >
        Every company, contact, deal, project, task, note, meeting, document, stored file and
        mail message in this install is dropped, and the backup&apos;s are put in their place.
        There is no way to restore part of a backup and no way to pick one record out of one.
        If what you want is to load a spreadsheet, or another CRM&apos;s data, or one deal you
        deleted last week, this is not the tool and using it would lose everything else.
      </Limitation>

      <Limitation
        testId="restore-undo"
        headline="The only way back is a safety backup you must be able to open."
      >
        Conduit writes a full backup of this install as it is now before it destroys anything,
        and it encrypts that backup with the passphrase you type here -- the same one that
        opens the archive you are restoring. That is deliberate: it is a passphrase you have
        demonstrably got, so it adds nothing new to lose. It also means the undo is only an
        undo while you still have it.
      </Limitation>

      {/*
        THE TWO PROMPTS, EXPLAINED BEFORE THE FIRST ONE APPEARS rather than at
        the moment the second one surprises somebody. The dialogs say it again;
        this is the half that can be read while deciding whether to start.
      */}
      <div
        data-testid="restore-two-prompts"
        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600"
      >
        <p className="font-semibold text-slate-800">You will be asked for your password twice.</p>
        <p className="mt-1">
          Once to open the archive and build the preview, and again at the moment the database
          is replaced. That is not a glitch and it is not caution for its own sake: a password
          confirmation here is good for exactly one request and cannot be carried forward,
          because what it proves is that you are at the keyboard <em>now</em> -- and a preview
          somebody reads for two minutes before pressing the last button should not be
          carrying that proof forward on their behalf. You will also type the archive&apos;s
          passphrase twice, once to open it and once at the confirmation, for the same reason:
          it is not kept between the two requests.
        </p>
      </div>

      {error !== null && (
        <p
          role="alert"
          data-testid="restore-error"
          className="whitespace-pre-line rounded-md border border-red-300 bg-red-100 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      {outcome !== null && <RestoreOutcomeCard outcome={outcome} installName={installName} />}

      {preview === null
        ? (
          <RestoreUploadCard
            form={form}
            formProblem={formProblem}
            blocked={blocked}
            busy={busy}
            previewing={previewing}
            onChange={onChange}
            onPreview={onPreview}
          />
        )
        : (
          <RestorePlanCard
            preview={preview}
            installName={installName}
            typedName={typedName}
            confirmPassphrase={confirmPassphrase}
            busy={busy}
            applying={applying}
            cancelling={cancelling}
            onTypedName={onTypedName}
            onConfirmPassphrase={onConfirmPassphrase}
            onApply={onApply}
            onDiscard={onDiscard}
          />
        )}
    </section>
  );
}

/**
 * STEP ONE: the archive and its passphrase.
 *
 * NO REPEAT FIELD FOR THE PASSPHRASE, unlike the backup form above, and
 * settings-data-lib.ts's RestoreFormState says why: this passphrase either
 * opens an archive that already exists or it does not, and the answer arrives
 * in seconds. The backup's repeat field exists because a typo there is
 * discovered on the day the backup is needed.
 */
function RestoreUploadCard(props: {
  form: RestoreFormState;
  formProblem: string | null;
  blocked: string | null;
  busy: boolean;
  previewing: boolean;
  onChange: (next: RestoreFormState) => void;
  onPreview: () => void;
}) {
  const { form, formProblem, blocked, busy, previewing, onChange, onPreview } = props;
  return (
    <div
      data-testid="restore-upload"
      className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-semibold text-slate-900">1. Choose a backup, and see what it would do</h3>
      <p className="text-sm text-slate-600">
        A <code>.7z</code> written by this Conduit or by an older one. Nothing is changed by
        this step: the archive is opened on the server, checked against what this build can
        load, and you get a list of exactly what a restore would destroy and replace. A backup
        from a <em>newer</em> Conduit than this one is refused, because its data may use
        columns this build does not have.
      </p>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Backup file
        <input
          type="file"
          accept=".7z,application/x-7z-compressed"
          disabled={busy}
          data-testid="restore-file"
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium disabled:cursor-not-allowed disabled:bg-slate-100 max-md:min-h-11"
          onChange={(event) => {
            onChange({ ...form, file: event.target.files?.[0] ?? null });
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        The passphrase this backup was written with
        <Input
          type="password"
          value={form.passphrase}
          maxLength={MAX_PASSPHRASE_LENGTH}
          autoComplete="off"
          disabled={busy}
          data-testid="restore-passphrase"
          onChange={(event) => { onChange({ ...form, passphrase: event.target.value }); }}
        />
      </label>
      {/*
        THE SAME REFUSAL THE BACKUP FORM MAKES, from the same shared rule. A
        passphrase carrying a line break cannot open an archive that was written
        with one either, and saying so here beats a 400 that says "validation".
      */}
      {formProblem !== null && (
        <p role="alert" data-testid="restore-form-problem" className="text-sm text-red-600">
          {formProblem}
        </p>
      )}
      <p className="text-xs text-slate-500">
        Conduit never compares your passphrase to anything -- it hands it to the archiver. So
        a wrong passphrase and a damaged archive fail in the same place with the same
        sentence, and neither answer tells you whether you were close.
      </p>
      <div className="flex items-center justify-end gap-3">
        {/* NO CONTROL DISABLED FOR A REASON NOBODY CAN SEE. */}
        {blocked !== null && (
          <span data-testid="restore-preview-blocked" className="text-xs text-slate-500">
            {blocked}
          </span>
        )}
        <Button
          data-testid="restore-preview"
          disabled={busy || blocked !== null}
          onClick={onPreview}
        >
          {previewing ? "Opening the archive..." : "Preview this restore"}
        </Button>
      </div>
    </div>
  );
}

/**
 * STEP TWO: WHAT THE SERVER SAID, RENDERED AND NOT RECONSTRUCTED.
 *
 * EVERY NUMBER AND EVERY SENTENCE BELOW CAME OUT OF POST /api/restore/inspect.
 * This component does not count anything, does not predict anything and does
 * not compose a description of the work: the plan is a value the server built,
 * the page prints it, and apply consumes THE SAME OBJECT addressed by its id.
 * @conduit/shared's plan.ts carries the argument in full; the short version is
 * that a preview which is a second implementation of apply is a preview that
 * can disagree with it, and the thing being previewed here is destruction.
 *
 * THE DESTRUCTION LIST COMES FROM destructiveEffects AND NOT FROM A FILTER
 * WRITTEN HERE. That helper exists in the shared module precisely so the
 * confirmation and the list below it cannot disagree about what is destroyed --
 * they are reading one array.
 */
function RestorePlanCard(props: {
  preview: RestoreInspection;
  installName: string | null;
  typedName: string;
  confirmPassphrase: string;
  busy: boolean;
  applying: boolean;
  cancelling: boolean;
  onTypedName: (value: string) => void;
  onConfirmPassphrase: (value: string) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const {
    preview, installName, typedName, confirmPassphrase, busy, applying, cancelling,
    onTypedName, onConfirmPassphrase, onApply, onDiscard,
  } = props;
  const plan = preview.plan;
  const destroys = destructiveEffects(plan);
  const applicable = planIsApplicable(plan);
  const confirmBlocked = restoreConfirmBlocked({
    plan, installName, typedName, passphrase: confirmPassphrase,
  });
  // A FIXED LOCALE AND A FIXED ZONE, and the ZONE is the half a review found
  // missing. This is a time printed beside a fact about a file on a server;
  // pinning the locale fixes only the FORMAT, and two operators in different
  // time zones reading the same preview would still have disagreed about when
  // it expires -- which is the exact confusion the pinning was for. PlanView's
  // `expiresAt` is documented as ISO 8601 UTC, so UTC is what is rendered, and
  // the label beside it says so rather than leaving a bare clock time to be
  // read as local.
  const expires = new Date(plan.expiresAt).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });

  return (
    <div
      data-testid="restore-plan"
      className="flex flex-col gap-4 rounded-md border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-semibold text-slate-900">2. What this backup would do</h3>

      <dl data-testid="restore-plan-source" className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-slate-700">File: </dt>
          <dd className="inline">{plan.source.filename}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Size: </dt>
          <dd className="inline">{formatBytes(plan.source.bytes)}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Members: </dt>
          <dd className="inline">{plan.source.memberCount.toLocaleString("en-GB")}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Unpacked: </dt>
          <dd className="inline">{formatBytes(plan.source.stagedBytes)}</dd>
        </div>
        <div className="sm:col-span-2">
          {/*
            THE DIGEST OF THE BYTES THAT WERE UPLOADED, so an operator can tell
            which of several backups this is without opening any of them.
          */}
          <dt className="inline font-medium text-slate-700">SHA-256: </dt>
          <dd className="inline break-all font-mono">{plan.source.sha256}</dd>
        </div>
      </dl>

      {/*
        A REFUSAL IS STILL A PLAN and is rendered through the same path as one
        that will run -- @conduit/shared's plan.ts makes that a design decision
        rather than a convenience. When there is one, the archive has already
        been deleted from the server and there is nothing to confirm.
      */}
      {plan.refusal !== null && (
        <div
          role="alert"
          data-testid="restore-refusal"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          <p className="font-semibold">This backup cannot be restored.</p>
          <p className="mt-1">{plan.refusal.message}</p>
          <p className="mt-1">
            Nothing was changed and the copy Conduit unpacked has already been deleted. The
            file on your own machine is untouched.
          </p>
        </div>
      )}

      {plan.findings.length > 0 && (
        <ul data-testid="restore-findings" className="flex flex-col gap-2">
          {plan.findings.map((finding) => (
            <li
              key={finding.code}
              data-testid={`restore-finding-${finding.code}`}
              data-severity={finding.severity}
              className={finding.severity === "warning"
                ? "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                : "rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"}
            >
              {finding.message}
            </li>
          ))}
        </ul>
      )}

      {/*
        WHAT IS ABOUT TO BE DESTROYED, CONCRETELY. The spec asks for row counts
        from the live database "so the operator sees what they are replacing
        rather than an abstraction", and the plan carries them: the count and
        unit are the effect's own, and the sentence under each is the one
        services/restore.ts wrote, which names the rows, the tables and the
        schemas it measured with the same function a backup's inventory uses.
        Nothing here is counted a second time by this page.
      */}
      <div data-testid="restore-destruction" className="rounded-md border border-red-300 bg-red-50 px-3 py-2">
        <p className="text-sm font-semibold text-red-900">What this destroys</p>
        {destroys.length === 0
          ? (
            <p className="mt-1 text-sm text-red-900">
              Nothing in this plan destroys anything.
            </p>
          )
          : (
            <ul className="mt-2 flex flex-col gap-2">
              {/*
                THE INDEX IS IN THE KEY HERE FOR THE REASON IT IS IN THE LIST
                BELOW: a plan is a list the server builds, and a page that
                assumed `op` was unique would break silently the day one
                repeated. A review found these two lists reading the same array
                and disagreeing about that. The TESTID still keys off `op`,
                which is what the journeys select on and what would go ambiguous
                rather than silently wrong.
              */}
              {destroys.map((effect, index) => (
                <li
                  key={`${effect.op}-${String(index)}`}
                  data-testid={`restore-destroys-${effect.op}`}
                  className="text-sm text-red-900"
                >
                  <span className="font-semibold">{effect.subject}</span>
                  {" -- "}
                  <span className="font-semibold">{planCountLabel(effect.count, effect.unit)}</span>
                  <p className="mt-0.5 text-xs text-red-800">{effect.detail}</p>
                </li>
              ))}
            </ul>
          )}
      </div>

      {plan.effects.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-slate-900">Everything that runs, in order</p>
          <ol data-testid="restore-effects" className="mt-2 flex flex-col gap-2">
            {plan.effects.map((effect, index) => (
              <li
                // The op is unique within a restore plan today; the index is in
                // the key anyway, because a plan is a list the server builds
                // and a page that assumed uniqueness would break silently the
                // day one repeated.
                key={`${effect.op}-${String(index)}`}
                data-testid={`restore-effect-${effect.op}`}
                data-destroys={effect.destroys ? "yes" : "no"}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <span className="font-medium text-slate-900">{effect.subject}</span>
                {" -- "}
                <span>{planCountLabel(effect.count, effect.unit)}</span>
                {effect.destroys && (
                  <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-800">
                    destroys
                  </span>
                )}
                <p className="mt-0.5 text-xs text-slate-500">{effect.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/*
        ONLY WHEN THERE IS SOMETHING LEFT ON THE SERVER, and a review found this
        rendering under a refusal and contradicting it. A refusal is not held:
        routes/restore.ts disposes of the staging before it writes the answer,
        so by the time this renders the archive is already gone and the plan id
        resolves to nothing. The refusal block above says exactly that, and this
        paragraph was underneath it announcing a deletion in half an hour --
        which is the page predicting server state instead of rendering it.
      */}
      {plan.refusal === null && (
        <p data-testid="restore-expiry" className="text-xs text-slate-500">
          Conduit has unpacked your backup onto the server to build this list, and what it
          unpacked is a decrypted copy: the mail key in the clear and every stored mail
          password. It is deleted when this restore runs, when you press Cancel, and in any
          case at {expires} UTC. Cancel is the fastest of the three.
        </p>
      )}

      {applicable && (
        <div className="flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-900">3. Confirm</p>
          {installName === null
            ? (
              <p role="alert" data-testid="restore-unnameable" className="text-sm text-red-900">
                This install&apos;s database cannot be named from its configuration, so a
                restore cannot be confirmed by typing it and the server will refuse one. An
                administrator needs to look at the server&apos;s configuration. Nothing you
                type here will work.
              </p>
            )
            : (
              <>
                {/*
                  THE NAME IS PRINTED NEXT TO THE FIELD, and that is the design
                  rather than a lapse. It is a deliberateness check and NOT a
                  secret: routes/restore.ts echoes it in the 400 too, and the
                  comparison behind it is deliberately not timing-safe. What
                  stops a stranger is the re-authentication and the archive
                  passphrase; what this stops is the reflexive click on the
                  right install. A page that hid the name would be implying a
                  protection that is not there.
                */}
                <p className="text-sm text-red-900">
                  Type this install&apos;s name to confirm. It is the database this Conduit is
                  connected to, and it is{" "}
                  <code data-testid="restore-install-name" className="font-mono font-semibold">{installName}</code>.
                  It is printed here on purpose: it is a check that you meant this, not a
                  password. What stops somebody else is the password below and the
                  archive&apos;s passphrase.
                </p>
                <label className="flex flex-col gap-1 text-xs font-medium text-red-900">
                  This install&apos;s name
                  <Input
                    type="text"
                    value={typedName}
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                    data-testid="restore-confirm-name"
                    onChange={(event) => { onTypedName(event.target.value); }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-red-900">
                  The archive passphrase, again
                  <Input
                    type="password"
                    value={confirmPassphrase}
                    maxLength={MAX_PASSPHRASE_LENGTH}
                    autoComplete="off"
                    disabled={busy}
                    data-testid="restore-confirm-passphrase"
                    onChange={(event) => { onConfirmPassphrase(event.target.value); }}
                  />
                </label>
                <p className="text-xs text-red-800">
                  Asked again because it is not kept between the two requests, and because it
                  is what the safety backup is encrypted with. If it does not match the one
                  that opened this archive, Conduit refuses before it touches anything -- a
                  safety backup written under a passphrase you have never successfully used
                  would be no undo at all.
                </p>
                {/*
                  THE RESTART, SAID BEFORE THE BUTTON AS WELL AS AFTER IT. One
                  line here, because it is a thing to plan for; the honest
                  account of what does and does not enforce it is in
                  RestartAdvice, where it is read after the restore has run.
                */}
                <p className="text-xs text-red-800">
                  You will need to restart Conduit afterwards, and nothing here will do it for
                  you or stop you carrying on without it.
                </p>
              </>
            )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            {confirmBlocked !== null && !applying && (
              <span data-testid="restore-apply-blocked" className="text-xs text-red-800">
                {confirmBlocked}
              </span>
            )}
            <Button
              variant="outline"
              data-testid="restore-cancel"
              disabled={busy}
              onClick={onDiscard}
            >
              {cancelling ? "Deleting..." : "Cancel and delete the upload"}
            </Button>
            <Button
              variant="danger"
              data-testid="restore-apply"
              disabled={busy || confirmBlocked !== null}
              onClick={onApply}
            >
              {applying ? "Restoring..." : "Restore, replacing everything"}
            </Button>
          </div>
          {applying && (
            <p data-testid="restore-running" className="text-xs text-red-900">
              Conduit is writing the safety backup, then loading. This install is refusing
              every change until it finishes -- including from other tabs -- and it may take
              as long as taking a backup does. Leave this tab open.
            </p>
          )}
        </div>
      )}

      {!applicable && (
        <div className="flex justify-end">
          <Button variant="outline" data-testid="restore-cancel" disabled={busy} onClick={onDiscard}>
            {cancelling ? "Clearing..." : "Clear this preview"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** What happened, and the one thing left to do. */
function RestoreOutcomeCard(
  { outcome, installName }: { outcome: RestoreOutcome; installName: string | null },
) {
  return (
    <div
      data-testid="restore-outcome"
      className="flex flex-col gap-3 rounded-md border border-green-200 bg-green-50 px-3 py-3"
    >
      <p className="text-sm font-semibold text-green-800">The backup has been restored.</p>
      {/*
        THE SERVER'S OWN SENTENCE, echoed rather than paraphrased. It is the
        record of what actually ran, and the counts beside it are the executor's
        account of how many effects were dispatched and how many are in the
        world -- which on a run that reached the end are equal.
      */}
      <p className="text-sm text-green-800">{outcome.message}</p>
      <p className="text-xs text-green-800">
        {outcome.realised.toLocaleString("en-GB")} of{" "}
        {outcome.dispatched.toLocaleString("en-GB")} planned steps completed.
      </p>
      <RestartAdvice installName={installName} />
    </div>
  );
}

/**
 * THE RESTART ADVICE, AND A CLAIM THAT WAS MEASURED AND WITHDRAWN.
 *
 * THIS PARAGRAPH USED TO BE GOING TO SAY that the app cannot serve writes after
 * a restore, so an operator would find out for themselves. THAT IS FALSE, and
 * it is false in the direction that would have made this page dangerous:
 *
 *   - Writes DO fail immediately afterwards, but only for about sixty seconds.
 *     The reason is createUserResolver's cache TTL: the process is still
 *     holding identities that belonged to the install that has just been
 *     replaced, and those rows do not exist in the restored data.
 *   - Then the TTL expires, the identity is resolved again against the restored
 *     database, AND WRITES SILENTLY START WORKING -- with the process still
 *     holding state from the install that is gone.
 *
 * So a failing write is NOT the signal that a restart is needed, and a working
 * write is NOT evidence that it is not. The page must say that, because the
 * alternative is an operator who tries a write, sees it succeed, and concludes
 * the advice was optional. Nothing in this application enforces the restart --
 * there is no supervisor here that will do it, and the write gate that refused
 * changes DURING the restore is deliberately reopened the moment it finishes,
 * because an install that answered 503 to every write until somebody restarted
 * it would be a worse failure than a stale cache.
 *
 * SAYING "NOTHING ENFORCES THIS" IS THE POINT. A page that wrote "restart
 * Conduit now" and left it there would be implying that something had been
 * arranged. Nothing has been.
 */
function RestartAdvice({ installName }: { installName: string | null }) {
  return (
    <div data-testid="restore-restart" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p className="font-semibold">Restart Conduit now, and nothing here will make you.</p>
      <p className="mt-1">
        This process is still running and will keep answering. For about a minute changes will
        fail, because it is still holding accounts that belonged to the install that has just
        been replaced -- and then that cache expires, changes quietly start working again, and
        the process carries on holding state from an install that no longer exists. Nothing on
        this screen will tell you when that happens.
      </p>
      <p className="mt-1">
        So a change that fails is not the signal to restart, and a change that works is not
        evidence you can skip it. Both happen either way, about sixty seconds apart. Restart
        it.
      </p>
      {/*
        THE COMMAND IS OFFERED ONLY WHERE THE NAME IS KNOWN, and only as what it
        is. A review caught two overclaims here.
        THE FIRST WAS A CONSTANT. This read `installName ?? "conduit"`, which is
        the one thing routes/restore.ts refuses to do with this value: it
        answers 503 rather than invent a name, because "a constant is a
        confirmation everybody can type" -- and a constant printed as a command
        is a wrong command with the server's authority behind it.
        THE SECOND WAS THE UNIT. `installName` is documented as exactly one
        thing, the database this install is connected to. Under YunoHost that IS
        the app's instance id, and the systemd unit, the system user and the
        database all carry it (conf/systemd.service templates all three from
        __APP__). On anything else it is a database name that may have nothing
        to do with a service name -- so the sentence says which install it is
        true of instead of stating it flatly.
      */}
      {installName !== null && (
        <p className="mt-1">
          On a YunoHost install the service carries the same name as the database, so this is
          the command:{" "}
          <code className="font-mono">sudo systemctl restart {installName}</code>. Elsewhere,
          restart it however you normally do.
        </p>
      )}
      {/*
        WHAT WAS DELETED HERE WAS A SENTENCE SAYING MAIL SYNC WAS ALREADY BACK.
        services/restore.ts restarts it with `await sync?.start()` inside a
        `catch {}` that swallows a failure without logging, and `sync` is null
        whenever the process has no sync manager -- so "already started again"
        was a claim the code does not support, on the one screen whose whole
        design is about not making claims nothing is behind.
      */}
      <p className="mt-1">
        A restart also puts the mail sync back on a footing this process can vouch for.
      </p>
    </div>
  );
}
