import { useState } from "react";
import type { ReactNode } from "react";
import { planIsApplicable } from "@conduit/shared";
import type {
  CsvImportField, CsvImportFieldDef, CsvMappingView, ImportOutcome, PlanView,
} from "@conduit/shared";
import {
  applyImport, cancelImport, inspectCsvImport, inspectExportImport, planCsvImport, useUsers,
} from "../queries";
import { ApiError } from "../api";
import { Button } from "../components/ui/button";
import { formatBytes, planCountLabel } from "./settings-data-lib";
import {
  EMPTY_IMPORT_UPLOAD, applyKeptTheImportPreview, failureKeepsTheMapping, importProblem,
  importUploadBlocked, initialChoices, mappingBlocked, mappingFrom,
} from "./settings-import-lib";
import type { ImportUploadState, MappingChoices } from "./settings-import-lib";

/**
 * SETTINGS -> IMPORT. Phase 7.7's last surface, and the fourth and fifth
 * artefacts on a page that already had to keep three apart.
 *
 * THE ONE THING THIS SECTION EXISTS TO PREVENT is somebody reaching for an
 * import when they meant a restore, or the other way round. 7.7's spec says so
 * in as many words, and the danger is not symmetric:
 *
 *   AN IMPORT ADDS ROWS. Every effect either importer plans says
 *   `destroys: false`; a row already here is skipped rather than overwritten;
 *   and the worst a mistaken import can do is leave rows an operator archives.
 *   A RESTORE REPLACES EVERYTHING, and the only way back is a safety backup.
 *
 * So this section sits ABOVE the restore, reads in slate rather than red, says
 * what it does in its first sentence, and each card states its LIMITATION in
 * the same component and the same weight the export's and the backup's are
 * stated in. The restore's own copy points back up here for the operator who
 * arrived at the wrong one -- which it could not do before this section
 * existed, and which is the prose half of the same requirement.
 *
 * ONE PREVIEW AT A TIME, AND THE PAGE SAYS SO RATHER THAN DISCOVERING IT.
 * services/intake-plan.ts holds ONE session for the whole install, shared with
 * the restore, so a preview waiting anywhere refuses every other upload with
 * `import_busy`. This component holds a single `preview` for both cards for
 * exactly that reason: two independent card states would have offered a button
 * whose only possible answer was a 409.
 *
 * THE PREVIEW IS RENDERED, NEVER RECONSTRUCTED, which is the rule the restore's
 * plan card is built on and it is the same rule here: every count and every
 * sentence below came out of the server's plan. @conduit/shared's plan.ts
 * carries the argument.
 */

type ImportKind = "export" | "csv";

/** What is in flight, so every disabled control can say which. */
type Running = null | "export-preview" | "csv-columns" | "csv-preview" | "apply" | "cancel";

export function ImportSection(props: {
  /** Anything at all is running on this page, including elsewhere on it. */
  busy: boolean;
  /** Reported up so the page's one-thing-at-a-time rule covers this section. */
  onRunning: (running: boolean) => void;
}) {
  const { busy, onRunning } = props;
  const users = useUsers();

  const [exportUpload, setExportUpload] = useState<ImportUploadState>(EMPTY_IMPORT_UPLOAD);
  const [csvUpload, setCsvUpload] = useState<ImportUploadState>(EMPTY_IMPORT_UPLOAD);
  /**
   * WHAT THE MAPPING STEP ANSWERED, held verbatim and never rebuilt.
   *
   * The columns, their samples, the delimiter that was sniffed and the picker's
   * own options all come out of this object. There is no id in it, and its
   * absence is routes/import.ts's decision 2: the mapping step holds nothing on
   * the server, so what identifies the file for the next request is the digest
   * this carries -- `source.sha256`, echoed back untouched.
   */
  const [mapping, setMapping] = useState<CsvMappingView | null>(null);
  const [choices, setChoices] = useState<MappingChoices>({});
  const [owner, setOwner] = useState("");
  const [preview, setPreview] = useState<{ kind: ImportKind; plan: PlanView } | null>(null);
  const [outcome, setOutcome] = useState<{ kind: ImportKind; result: ImportOutcome } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Running>(null);

  function begin(what: Exclude<Running, null>) {
    setError(null);
    // THE LAST IMPORT'S REPORT GOES WHEN A NEW OPERATION STARTS, and a review
    // is why it is here rather than on each success. It was cleared only where
    // something new SUCCEEDED -- so an import that finished, followed by a
    // second one refused with "nothing has been imported", left BOTH cards on
    // screen: a green "The import has finished" above a red sentence saying it
    // had not. One place, every path.
    setOutcome(null);
    setRunning(what);
    onRunning(true);
  }
  function end() {
    setRunning(null);
    onRunning(false);
  }

  async function readColumns() {
    const file = csvUpload.file;
    if (file === null) return;
    begin("csv-columns");
    try {
      const answer = await inspectCsvImport({
        file,
        delimiter: csvUpload.delimiter === "" ? undefined : csvUpload.delimiter,
      });
      setMapping(answer.mapping);
      setChoices(initialChoices(answer.mapping));
      // THE FILE STAYS IN STATE AND THE INPUT GOES. The upload card is replaced
      // by the mapping card, so its file input unmounts -- and the file has to
      // survive that, because routes/import.ts sends it AGAIN with the mapping.
      // This is the mirror of the restore's rule rather than an exception to
      // it: there the form is emptied because a preview replaces the card and
      // nothing needs the file again; here something does.
    } catch (thrown) {
      setError(importProblem(thrown, "preview"));
    } finally {
      end();
    }
  }

  async function previewCsv() {
    const file = csvUpload.file;
    const view = mapping;
    if (file === null || view === null) return;
    begin("csv-preview");
    try {
      const answer = await planCsvImport({
        file,
        mapping: mappingFrom(choices, { delimiter: view.dialect.delimiter, owner }),
        // THE SERVER'S OWN DIGEST OF THE BYTES THE COLUMNS WERE READ FROM.
        // Never computed here: it is what the mapping step reported, quoted
        // back, so the route can refuse a mapping built against a different
        // file. See routes/import.ts.
        sha256: view.source.sha256,
      });
      setPreview({ kind: "csv", plan: answer.plan });
    } catch (thrown) {
      setError(importProblem(thrown, "preview"));
      if (!failureKeepsTheMapping(thrown)) {
        // THE ONE FAILURE THAT MAKES A MAPPING UNTRUE: a different file. A
        // mapping is a list of column POSITIONS, so there is nothing to keep.
        setMapping(null);
        setChoices({});
        setCsvUpload(EMPTY_IMPORT_UPLOAD);
      }
    } finally {
      end();
    }
  }

  async function previewExport() {
    const file = exportUpload.file;
    if (file === null) return;
    begin("export-preview");
    try {
      const answer = await inspectExportImport({ file });
      setPreview({ kind: "export", plan: answer.plan });
      // THE FORM IS EMPTIED HERE AND NOT ON THE FAILING PATH, which is the
      // restore's own rule and its reasoning transfers exactly. A file input is
      // uncontrolled, so React cannot empty one by re-rendering: on SUCCESS the
      // card is replaced and the input unmounts, so state that survived would
      // leave the page believing it held a file nobody can see. On FAILURE the
      // card stays mounted with the operator's selection still in it, and
      // clearing the state behind it would put "Choose a file to enable this"
      // under a filename.
      setExportUpload(EMPTY_IMPORT_UPLOAD);
    } catch (thrown) {
      setError(importProblem(thrown, "preview"));
    } finally {
      end();
    }
  }

  async function apply() {
    const held = preview;
    if (held === null) return;
    begin("apply");
    try {
      const result = await applyImport({ planId: held.plan.planId, kind: held.kind });
      setOutcome({ kind: held.kind, result });
      // The preview is gone on the server the moment apply took it, so the page
      // stops offering it -- and the mapping goes with it, because the file it
      // described has now been imported.
      setPreview(null);
      setMapping(null);
      setChoices({});
      setCsvUpload(EMPTY_IMPORT_UPLOAD);
      setOwner("");
    } catch (thrown) {
      setError(importProblem(thrown, "apply"));
      if (!applyKeptTheImportPreview(thrown)) {
        // THE SERVER CONSUMED THE PLAN, or nobody can say whether it did.
        // Either way the id will not resolve again, so the page must not leave
        // a button pointing at it -- a second press would answer 404 and read
        // as a second, different failure.
        setPreview(null);
        // AND THIS IS WHERE THE MAPPING SURVIVES A CHANGED WORLD. An
        // `import_csv_changed` consumes the plan and says, in the engine's own
        // words, that the column mapping is unaffected -- so the page drops
        // back to the mapping card with every choice still made and the file
        // still in hand, and one press re-plans it. Throwing it away would be
        // the page charging the operator five minutes for a row somebody else
        // created while they read a preview.
        if (!failureKeepsTheMapping(thrown)) {
          setMapping(null);
          setChoices({});
          setCsvUpload(EMPTY_IMPORT_UPLOAD);
        }
      }
    } finally {
      end();
    }
  }

  async function discard() {
    const held = preview;
    if (held === null) return;
    begin("cancel");
    try {
      await cancelImport(held.plan.planId);
    } catch (thrown) {
      // A 404 IS A SUCCESS HERE: the plan expiring between the render and the
      // click means the thing this was going to delete is already gone, and
      // reporting that as a failure would be telling somebody to worry about
      // the outcome they asked for.
      if (!(thrown instanceof ApiError) || thrown.code !== "import_plan_unknown") {
        // AND A FAILED CANCEL KEEPS THE CARD, which is the correction the
        // restore's own cancel had to have: DELETE is a write method, so
        // app.ts's write gate refuses it for the whole of any restore that
        // happens to be running. Clearing the preview here would leave a staged
        // upload holding the install's one intake slot with no button anywhere
        // that could release it.
        setError(
          `The upload could not be deleted, so it is still on the server. `
          + `${importProblem(thrown, "preview")} Try Cancel again in a moment; if it keeps `
          + `failing the upload is deleted on its own when this preview expires.`,
        );
        end();
        return;
      }
    }
    setPreview(null);
    setMapping(null);
    setChoices({});
    setCsvUpload(EMPTY_IMPORT_UPLOAD);
    setOwner("");
    end();
  }

  const applying = running === "apply";
  const cancelling = running === "cancel";
  // A PREVIEW WAITING ANYWHERE BLOCKS EVERY OTHER UPLOAD, because the server
  // holds one session for the whole install. Said here rather than met as a
  // 409.
  const held = preview !== null
    ? "A preview is already waiting below. Import it or cancel it first -- Conduit holds one "
      + "upload at a time, and a restore would be refused too."
    : null;

  return (
    <section data-testid="import-section" className="flex flex-col gap-4 rounded-md border-2 border-sky-200 bg-sky-50/40 p-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-sky-900">Import -- putting a file in</h2>
        {/*
          THE SENTENCE THAT SEPARATES THIS FROM THE THING BELOW IT, and it is
          the requirement rather than the styling. Somebody scrolling for "get
          my data in" meets the additive tool first and never has to consider
          the destructive one; somebody who arrived meaning to restore is told
          in one line which of the two they are looking at.
        */}
        <p data-testid="import-lead" className="text-sm text-sky-900">
          Both of these ADD rows to this install. Nothing that is already here is changed,
          overwritten or deleted -- a record the file already matches is left exactly as it is --
          and anything you did not want can be archived afterwards. That is the whole difference
          between this and the restore below, which replaces everything and cannot be undone
          except from a safety backup.
        </p>
      </div>

      {error !== null && (
        <p
          role="alert"
          data-testid="import-error"
          className="whitespace-pre-line rounded-md border border-red-300 bg-red-100 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      {outcome !== null && <ImportOutcomeCard outcome={outcome.result} kind={outcome.kind} />}

      <ExportImportCard
        upload={exportUpload}
        blocked={held ?? importUploadBlocked(exportUpload, busy, running === "export-preview")}
        busy={busy}
        running={running === "export-preview"}
        onChange={setExportUpload}
        onPreview={() => { void previewExport(); }}
      />

      <CsvImportCard
        upload={csvUpload}
        mapping={mapping}
        choices={choices}
        owner={owner}
        users={users.data ?? []}
        usersFailed={users.error !== null}
        held={held}
        blocked={held ?? importUploadBlocked(csvUpload, busy, running === "csv-columns")}
        busy={busy}
        readingColumns={running === "csv-columns"}
        previewing={running === "csv-preview"}
        onChange={setCsvUpload}
        onChoice={(column, field) => { setChoices((was) => ({ ...was, [column]: field })); }}
        onOwner={setOwner}
        onReadColumns={() => { void readColumns(); }}
        onPreview={() => { void previewCsv(); }}
        onStartOver={() => {
          setMapping(null);
          setChoices({});
          setCsvUpload(EMPTY_IMPORT_UPLOAD);
          setOwner("");
          setError(null);
        }}
      />

      {preview !== null && (
        <ImportPlanCard
          kind={preview.kind}
          plan={preview.plan}
          busy={busy}
          applying={applying}
          cancelling={cancelling}
          onApply={() => { void apply(); }}
          onDiscard={() => { void discard(); }}
        />
      )}
    </section>
  );
}

/**
 * The limitation, rendered so it cannot be skimmed past.
 *
 * A COPY OF settings-data.tsx's COMPONENT RATHER THAN AN IMPORT OF IT, and that
 * is worth a sentence because the obvious move is the other one. That one is a
 * local function in a module that does not export it, and widening its
 * visibility to share four lines of markup would couple two sections that are
 * deliberately styled apart -- the amber note reads as a caveat beside a
 * download, and here it has to read the same way beside something additive.
 * What must not drift is the REQUIREMENT, which is that each artefact states
 * what it CANNOT do in the same place and the same weight; that is held by the
 * journeys asserting it on all five.
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

function ImportCard({ title, testId, children }: {
  title: string; testId: string; children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

/** A file input, spelled once for both cards. */
function FileField({ label, accept, testId, disabled, onFile }: {
  label: string; accept: string; testId: string; disabled: boolean;
  onFile: (file: File | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        data-testid={testId}
        className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-xs file:font-medium disabled:cursor-not-allowed disabled:bg-slate-100 max-md:min-h-11"
        onChange={(event) => { onFile(event.target.files?.[0] ?? null); }}
      />
    </label>
  );
}

/** The reason a control is off, beside the control. Never absent. */
function Blocked({ testId, reason }: { testId: string; reason: string | null }) {
  if (reason === null) return null;
  return <span data-testid={testId} className="text-xs text-slate-500">{reason}</span>;
}

/**
 * THE EXACT IMPORTER: Conduit reading back its own export.
 *
 * ITS LIMITATION IS THE ONE AN OPERATOR MUST LEARN FROM THE PREVIEW RATHER THAN
 * FROM AN EMPTY DEALS LIST. It imports companies and contacts and nothing else,
 * and the shortfall is in the EXPORT FORMAT rather than in the importer: deals
 * have no pipeline or stage sheet to point at, notes and meetings and files need
 * a `users` row the export does not carry, documents have no line items. The
 * engine emits one finding per skipped sheet naming the specific missing thing,
 * and the plan card below renders every one of them.
 */
function ExportImportCard(props: {
  upload: ImportUploadState;
  blocked: string | null;
  busy: boolean;
  running: boolean;
  onChange: (next: ImportUploadState) => void;
  onPreview: () => void;
}) {
  const { upload, blocked, busy, running, onChange, onPreview } = props;
  return (
    <ImportCard title="From a Conduit export" testId="import-export-card">
      <p className="text-sm text-slate-600">
        The <code>.zip</code> the Export button above produces, from this Conduit or another
        one. Records keep the ids they were exported with, so importing the same archive twice
        does not create anything twice, and a record that is already here is left exactly as it
        is rather than overwritten.
      </p>
      <Limitation
        testId="import-export-limitation"
        headline="It brings back companies and contacts. Not deals, tasks, projects, notes, meetings, documents or files."
      >
        That is a limit of what an export can describe rather than of this importer, and the
        preview names it sheet by sheet before you import anything: deals have no pipeline or
        stage to point at, notes and meetings and files need the people who wrote them, and a
        quote would come back with totals over no lines. If you need all of it back, that is a
        restore from a backup and not an import.
      </Limitation>
      <div className="flex flex-col gap-3">
        <FileField
          label="The export .zip"
          accept=".zip,application/zip"
          testId="import-export-file"
          disabled={busy}
          onFile={(file) => { onChange({ ...upload, file }); }}
        />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* NO CONTROL DISABLED FOR A REASON NOBODY CAN SEE. */}
          <Blocked testId="import-export-blocked" reason={blocked} />
          <Button
            data-testid="import-export-preview"
            disabled={busy || blocked !== null}
            onClick={onPreview}
          >
            {running ? "Opening the archive..." : "Preview this import"}
          </Button>
        </div>
      </div>
    </ImportCard>
  );
}

/**
 * THE FORGIVING IMPORTER, AND THE ONLY INTERACTIVE STEP IN THE WHOLE SPINE.
 *
 * Three stages in one card, because they are one job: choose a file, say what
 * its columns are, read what that would create. The middle one is the reason
 * this pipeline exists at all -- @conduit/shared's import-mapping.ts puts it
 * plainly: the mapping is a human decision that cannot exist before the headers
 * do.
 */
function CsvImportCard(props: {
  upload: ImportUploadState;
  mapping: CsvMappingView | null;
  choices: MappingChoices;
  owner: string;
  users: readonly { id: string; username: string; fullName: string | null }[];
  usersFailed: boolean;
  /**
   * A preview is already waiting, so no upload of any kind may start.
   *
   * PASSED DOWN TO THE MAPPING STEP AS WELL AS USED FOR THE UPLOAD BUTTON, and
   * a review of this file's own e2e journey is what found that it had to be:
   * a successful preview does NOT unmount the mapping step -- it renders the
   * plan card beside it, deliberately, so the operator can still see what they
   * mapped and so it is already there if a changed-world refusal drops them
   * back to it. Without this the "Preview what this creates" button stayed live
   * under a plan that was already waiting, and its only possible answer was the
   * 409 this page exists to say out loud instead of meeting.
   */
  held: string | null;
  blocked: string | null;
  busy: boolean;
  readingColumns: boolean;
  previewing: boolean;
  onChange: (next: ImportUploadState) => void;
  onChoice: (column: number, field: CsvImportField | "") => void;
  onOwner: (value: string) => void;
  onReadColumns: () => void;
  onPreview: () => void;
  onStartOver: () => void;
}) {
  const {
    upload, mapping, choices, owner, users, usersFailed, held, blocked, busy,
    readingColumns, previewing, onChange, onChoice, onOwner, onReadColumns, onPreview,
    onStartOver,
  } = props;

  return (
    <ImportCard title="From a spreadsheet or another CRM" testId="import-csv-card">
      <p className="text-sm text-slate-600">
        A <code>.csv</code> from Outlook, Pipedrive, HubSpot, a spreadsheet, or anything else
        that writes one. Conduit reads its header row, shows you what is in each column and
        lets you say what each one holds -- nothing is guessed on your behalf that you cannot
        change.
      </p>
      <Limitation
        testId="import-csv-limitation"
        headline="One file creates one kind of record: companies, or contacts."
      >
        A single sheet cannot create both, because linking them would mean inventing a company
        from a NAME -- and &quot;Acme&quot;, &quot;Acme Ltd&quot; and &quot;ACME&quot; in one
        column would become three companies with nothing in the preview able to say they should
        have been one. Import the companies first, then the contacts, and link them with the
        &quot;Company (by name)&quot; field. Duplicates are matched on the email address for a
        contact and the domain for a company, and a match is skipped rather than merged.
      </Limitation>

      {mapping === null
        ? (
          <div className="flex flex-col gap-3">
            <FileField
              label="The .csv file"
              accept=".csv,text/csv"
              testId="import-csv-file"
              disabled={busy}
              onFile={(file) => { onChange({ ...upload, file }); }}
            />
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
              Column separator
              {/*
                A NATIVE SELECT, AND NOT THE RADIX ONE THIS APP USES ELSEWHERE.
                The mapping step below renders one picker PER COLUMN, and a
                foreign export routinely has thirty; a portal-rendered listbox
                per column is a great deal of machinery for a control whose
                whole job is to choose from a fixed list, and on a phone the
                native element IS the platform's own picker. The two selects
                here and below are spelled the same way for that reason.
                A SNIFFER NOBODY CAN CORRECT DECIDES THE WHOLE IMPORT ON ITS
                OWN, which is why this is here at all: Excel on a machine whose
                locale uses the comma as a decimal separator writes semicolons,
                silently.
              */}
              <select
                value={upload.delimiter}
                disabled={busy}
                data-testid="import-csv-delimiter"
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100 max-md:min-h-11"
                onChange={(event) => { onChange({ ...upload, delimiter: event.target.value }); }}
              >
                <option value="">Work it out from the file</option>
                <option value=",">Comma</option>
                <option value=";">Semicolon</option>
                <option value={"\t"}>Tab</option>
                <option value="|">Pipe</option>
              </select>
            </label>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Blocked testId="import-csv-blocked" reason={blocked} />
              <Button
                data-testid="import-csv-columns"
                disabled={busy || blocked !== null}
                onClick={onReadColumns}
              >
                {readingColumns ? "Reading the columns..." : "Read the columns"}
              </Button>
            </div>
          </div>
        )
        : (
          <MappingStep
            view={mapping}
            choices={choices}
            owner={owner}
            users={users}
            usersFailed={usersFailed}
            held={held}
            busy={busy}
            previewing={previewing}
            onChoice={onChoice}
            onOwner={onOwner}
            onPreview={onPreview}
            onStartOver={onStartOver}
          />
        )}
    </ImportCard>
  );
}

/**
 * THE MAPPING STEP, RENDERED FROM WHAT THE SERVER READ OUT OF THE FILE.
 *
 * EVERY COLUMN IS ADDRESSED BY ITS POSITION AND LABELLED BY ITS HEADER, which
 * is @conduit/shared's rule and the reason the header is only ever displayed:
 * a foreign file can have two columns called "Email" and one called "", so a
 * name is not an identity. The position is what the operator is pointing at and
 * what the mapping carries.
 *
 * THE SAMPLES ARE THE POINT OF THE STEP. "Field 7", "Notes", "Value" and an
 * empty header are all real headers; the values underneath them are what a
 * person actually reads to decide what a column is.
 */
function MappingStep(props: {
  view: CsvMappingView;
  choices: MappingChoices;
  owner: string;
  users: readonly { id: string; username: string; fullName: string | null }[];
  usersFailed: boolean;
  /** A preview is already waiting. See CsvImportCard's own field. */
  held: string | null;
  busy: boolean;
  previewing: boolean;
  onChoice: (column: number, field: CsvImportField | "") => void;
  onOwner: (value: string) => void;
  onPreview: () => void;
  onStartOver: () => void;
}) {
  const {
    view, choices, owner, users, usersFailed, held, busy, previewing,
    onChoice, onOwner, onPreview, onStartOver,
  } = props;
  // THE HELD PREVIEW COMES FIRST, because it is the reason a person cannot act
  // on ANY of the choices below rather than a fact about the choices. A mapping
  // problem under a plan that is already waiting would be true and useless.
  const blocked = held ?? mappingBlocked({
    mapping: mappingFrom(choices, { delimiter: view.dialect.delimiter, owner }),
    columnCount: view.columns.length,
    busy,
    running: previewing,
  });

  return (
    <div data-testid="import-csv-mapping" className="flex flex-col gap-3">
      <dl data-testid="import-csv-source" className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-slate-700">File: </dt>
          <dd className="inline">{view.source.filename}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Size: </dt>
          <dd className="inline">{formatBytes(view.source.bytes)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium text-slate-700">Read for this step: </dt>
          {/*
            NOT THE FILE'S TOTAL, and CsvMappingView says so in the value
            itself. Counting the rows of a 200,000-row file means reading all of
            it, and this is the one stage a person waits in front of. The PLAN
            reads the whole file and its counts are the real ones.
          */}
          <dd className="inline">
            {view.sampled.toLocaleString("en-GB")} rows, to show you what is in each column.
            The preview reads the whole file, and sends it again to do it -- nothing of yours is
            kept on the server while you decide, so the one upload slot this install shares
            stays free for anybody who needs a restore.
          </dd>
        </div>
      </dl>

      {view.refusal !== null && (
        <div role="alert" data-testid="import-csv-refusal" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          <p className="font-semibold">This file cannot be read as a spreadsheet.</p>
          <p className="mt-1">{view.refusal.message}</p>
        </div>
      )}

      <Findings testId="import-csv-findings" prefix="import-csv-finding" findings={view.findings} />

      {view.columns.length > 0 && (
        <ul data-testid="import-csv-column-list" className="flex flex-col gap-2">
          {view.columns.map((column) => (
            <li
              key={column.index}
              data-testid={`import-csv-column-${String(column.index)}`}
              className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 text-sm">
                <p className="font-medium text-slate-900">
                  {column.header === ""
                    ? <span className="italic text-slate-500">Column {column.index + 1}, no name</span>
                    : column.header}
                </p>
                <p className="mt-0.5 break-words text-xs text-slate-500">
                  {column.samples.length === 0
                    ? "Every sampled row is empty here."
                    : column.samples.join("  |  ")}
                </p>
              </div>
              {/*
                THE LABEL IS THE ELEMENT AND NOT AN aria-label, and the two are
                not interchangeable here. A wrapping <label> gives the select
                its accessible name from its own text; an aria-label OVERRIDES
                that, so carrying both was two mechanisms for one name with the
                weaker one winning. The text is hidden because the column's
                header is already on screen beside it -- and it NAMES THE
                HEADER as well as the position, because "column 3" on its own
                is what a sighted operator can see and a screen-reader user
                cannot.
              */}
              <label className="flex shrink-0 flex-col gap-1 text-xs font-medium text-slate-600 sm:w-64">
                <span className="sr-only">
                  What column {column.index + 1}
                  {column.header === "" ? ", which has no name," : `, ${column.header},`}
                  {" holds"}
                </span>
                <select
                  value={choices[column.index] ?? ""}
                  disabled={busy}
                  data-testid={`import-csv-field-${String(column.index)}`}
                  className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100 max-md:min-h-11"
                  onChange={(event) => {
                    onChoice(column.index, event.target.value as CsvImportField | "");
                  }}
                >
                  <option value="">Do not import this column</option>
                  {/*
                    THE PICKER'S OPTIONS ARE THE SERVER'S OWN LIST, rendered
                    from the mapping view rather than from a constant this
                    bundle carries. A stale bundle would otherwise offer a field
                    the running server has dropped, and the operator would find
                    out from a refusal after they had mapped everything.
                  */}
                  {view.targets.map((target: CsvImportFieldDef) => (
                    <option key={target.field} value={target.field}>
                      {target.entity === "company" ? "Company: " : "Contact: "}
                      {target.label}
                      {target.required ? " (required)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}

      {/*
        THE OWNER, WHICH IS A MAPPING CONTROL AND NOT A COLUMN.
        services/import-csv.ts named it and left it to this task:
        `owner_user_id` is a Conduit user's uuid and no foreign file has one, so
        it cannot be read out of a cell -- but it can be decided once for the
        whole import. NOBODY IS THE DEFAULT, because it is the answer that
        cannot be wrong: an operator who has not chosen has not said that these
        four thousand contacts are Sam's.
      */}
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Owner for every imported record
        <select
          value={owner}
          disabled={busy}
          data-testid="import-csv-owner"
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-100 max-md:min-h-11 sm:max-w-xs"
          onChange={(event) => { onOwner(event.target.value); }}
        >
          <option value="">Nobody -- leave them unowned</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName ?? user.username}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-slate-500">
        A spreadsheet has no Conduit user in it, so this is a choice about the whole import
        rather than something read out of the file. Leave it as Nobody and the records arrive
        unowned, which is what happens if you do not choose.
        {usersFailed && " The list of people could not be loaded, so only Nobody is offered."}
      </p>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Blocked testId="import-csv-mapping-blocked" reason={blocked} />
        <Button variant="outline" data-testid="import-csv-restart" disabled={busy} onClick={onStartOver}>
          Choose a different file
        </Button>
        <Button
          data-testid="import-csv-preview"
          disabled={busy || blocked !== null}
          onClick={onPreview}
        >
          {previewing ? "Reading the file..." : "Preview what this creates"}
        </Button>
      </div>
    </div>
  );
}

/**
 * THE FINDINGS, KEYED `${code}-${index}`.
 *
 * BECAUSE IMPORT FINDINGS REPEAT, and on this pipeline they repeat under six
 * codes at once: one per bad row, one per unmapped column, one per duplicate
 * already here, one per duplicate inside the file, one per dropped value, one
 * per repair. React drops a duplicate-keyed child when a list RECONCILES, so a
 * finding the server chose to show would go missing from a preview with nothing
 * on screen to say one had.
 *
 * AND IT IS LATENT HERE TOO, WHICH IS WORTH SAYING BECAUSE THE FIRST VERSION OF
 * THIS COMMENT CLAIMED THE OPPOSITE AND WAS WRONG. It read "unlike the
 * restore's, this one reconciles in the ordinary way" -- and following the two
 * call sites shows it does not. The mapping step's list cannot be handed a
 * different array without `mapping` passing through null (the only way back to
 * the upload card unmounts it), and the plan card's cannot either: a second
 * preview is unreachable while one is held, and the paths that release one --
 * Cancel, a finished import, a changed-world refusal -- all set `preview` to
 * null and unmount the card first. React renders duplicate-keyed children on a
 * FIRST mount and only drops them when a list RECONCILES, and its warning is
 * compiled out of the production bundle the journeys drive.
 *
 * SO THE KEY IS RIGHT BY CONSTRUCTION AND NO TEST IN THIS SUITE CAN SEE IT,
 * exactly as e2e/data.spec.ts records for the restore's list. Inventing a path
 * that made it observable would be building a defect to prove a defence; saying
 * so is what the next reader who looks for a test needs instead. What holds it
 * is that both lists here render the SAME component, and that
 * services/import-csv.ts emits repeats under six codes at once -- so the day
 * one of these cards does gain a reconciling path, the key is already right.
 */
function Findings({ testId, prefix, findings }: {
  testId: string;
  prefix: string;
  findings: readonly { severity: "note" | "warning"; code: string; message: string }[];
}) {
  if (findings.length === 0) return null;
  return (
    <ul data-testid={testId} className="flex flex-col gap-2">
      {findings.map((finding, index) => (
        <li
          key={`${finding.code}-${String(index)}`}
          data-testid={`${prefix}-${finding.code}`}
          data-severity={finding.severity}
          className={finding.severity === "warning"
            ? "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            : "rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600"}
        >
          {finding.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * WHAT THE SERVER SAID THIS IMPORT WOULD CREATE, RENDERED AND NOT
 * RECONSTRUCTED.
 *
 * Every number and every sentence came out of the preview route. This component
 * counts nothing, predicts nothing and composes no description of the work:
 * @conduit/shared's plan.ts carries the argument at length, and the short
 * version is that a preview which is a second implementation of apply is a
 * preview that can disagree with it.
 */
function ImportPlanCard(props: {
  kind: ImportKind;
  plan: PlanView;
  busy: boolean;
  applying: boolean;
  cancelling: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const { kind, plan, busy, applying, cancelling, onApply, onDiscard } = props;
  const applicable = planIsApplicable(plan);
  /**
   * THE REASON BOTH CONTROLS ARE OFF, or null when the Import button is live.
   *
   * `running` IS SILENT because the buttons say it themselves -- "Importing..."
   * and "Deleting..." -- which is the arrangement restoreConfirmBlocked settled
   * on for the same row of the same shape.
   */
  const blocked = applying || cancelling
    ? null
    : busy
      ? "One thing at a time. Nothing here can be pressed until the operation already "
        + "running has finished."
      : applicable
        ? null
        : "There is nothing here to import. The reason is above.";
  const expires = new Date(plan.expiresAt).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  });

  return (
    <div data-testid="import-plan" data-kind={kind} className="flex flex-col gap-4 rounded-md border border-slate-300 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">What this import would create</h3>

      <dl data-testid="import-plan-source" className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium text-slate-700">File: </dt>
          <dd className="inline">{plan.source.filename}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-700">Size: </dt>
          <dd className="inline">{formatBytes(plan.source.bytes)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline font-medium text-slate-700">SHA-256: </dt>
          <dd className="inline break-all font-mono">{plan.source.sha256}</dd>
        </div>
      </dl>

      {plan.refusal !== null && (
        <div role="alert" data-testid="import-refusal" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          <p className="font-semibold">Nothing in this file can be imported.</p>
          <p className="mt-1">{plan.refusal.message}</p>
          <p className="mt-1">
            Nothing has been changed and the copy Conduit unpacked has already been deleted. The
            file on your own machine is untouched.
          </p>
        </div>
      )}

      <Findings testId="import-findings" prefix="import-finding" findings={plan.findings} />

      {/*
        WHAT WILL BE CREATED, AND THE SENTENCE THAT SAYS WHAT WILL NOT.
        The restore's card has a "What this destroys" box because a restore
        does; this one says the opposite in the same place, and it is not
        decoration: an operator arriving from the wrong control needs the page
        to answer "will this delete what I have?" without their having to
        reason about it.
      */}
      <div data-testid="import-creates" className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2">
        <p className="text-sm font-semibold text-sky-900">What this adds</p>
        {plan.effects.length === 0
          ? <p className="mt-1 text-sm text-sky-900">Nothing. There is nothing in this file to add.</p>
          : (
            <ul className="mt-2 flex flex-col gap-2">
              {plan.effects.map((effect, index) => (
                <li
                  key={`${effect.op}-${String(index)}`}
                  data-testid={`import-creates-${effect.op}`}
                  data-destroys={effect.destroys ? "yes" : "no"}
                  className="text-sm text-sky-900"
                >
                  <span className="font-semibold">{effect.subject}</span>
                  {" -- "}
                  <span className="font-semibold">{planCountLabel(effect.count, effect.unit)}</span>
                  <p className="mt-0.5 text-xs text-sky-800">{effect.detail}</p>
                </li>
              ))}
            </ul>
          )}
        <p className="mt-2 text-xs text-sky-800">
          Nothing else is touched. No record already in this install is changed, overwritten or
          deleted by an import, and anything you did not mean to add can be archived.
        </p>
      </div>

      {plan.refusal === null && (
        <p data-testid="import-expiry" className="text-xs text-slate-500">
          Your file is on the server while this preview is open. It is deleted when the import
          runs, when you press Cancel, and in any case at {expires} UTC. Until then no other
          import or restore can be started on this install.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {/*
          NO CONTROL DISABLED FOR A REASON NOBODY CAN SEE, and the button STAYS
          under a plan that cannot run rather than vanishing. That is the
          restore's settled ruling applied here rather than a second opinion:
          "a control that VANISHES is its own kind of unexplained -- the rule
          this page is built on is that nothing is off without a visible reason,
          not that nothing is ever off." An operator who pressed Preview and
          found the button gone has to work out whether they misread the page or
          the page misread the file.
          ONE SPAN, TWO REASONS, AND THEY CANNOT BOTH RENDER: the first is
          `busy`, the second is `!busy`. Two elements carrying one testid would
          be an ambiguous locator rather than a clearer page.
        */}
        {blocked !== null && (
          <span data-testid="import-apply-blocked" className="text-xs text-slate-500">
            {blocked}
          </span>
        )}
        <Button variant="outline" data-testid="import-cancel" disabled={busy} onClick={onDiscard}>
          {cancelling ? "Deleting..." : "Cancel and delete the upload"}
        </Button>
        <Button data-testid="import-apply" disabled={busy || !applicable} onClick={onApply}>
          {applying ? "Importing..." : "Import these records"}
        </Button>
      </div>
      {applying && (
        <p data-testid="import-running" className="text-xs text-slate-600">
          Conduit is adding the records, all of them in one transaction. If anything goes wrong
          none of them is added. Leave this tab open.
        </p>
      )}
    </div>
  );
}

/** What happened, in the server's own count. */
function ImportOutcomeCard({ outcome, kind }: { outcome: ImportOutcome; kind: ImportKind }) {
  return (
    <div data-testid="import-outcome" data-kind={kind} className="flex flex-col gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-3">
      <p className="text-sm font-semibold text-green-800">The import has finished.</p>
      {/*
        THE SERVER'S OWN SENTENCE, echoed rather than paraphrased: it carries
        the count the executor actually accounted for, which is the only number
        on this page that is a record of what happened rather than of what was
        planned.
      */}
      <p className="text-sm text-green-800">{outcome.message}</p>
      <p className="text-xs text-green-800">
        {outcome.realised.toLocaleString("en-GB")} of{" "}
        {outcome.dispatched.toLocaleString("en-GB")} planned steps completed.
      </p>
      <p className="text-xs text-green-800">
        Nothing that was already here was changed, and no restart is needed -- an import adds
        records through the same code paths the rest of Conduit writes with.
      </p>
    </div>
  );
}
