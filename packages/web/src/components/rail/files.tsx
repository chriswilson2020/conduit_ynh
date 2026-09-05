import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { clsx } from "clsx";
import type { FileMeta } from "@conduit/shared";
import { ApiError, apiUrl } from "../../api";
import {
  emptyHeldList, humanSize, identityKey, newArrivalsLabel, pendingArrivals, takeWholeList,
  type HeldList,
} from "../../lib";
import { useLatest, useOwnWriteNonce } from "../../hooks";
import { useFiles, useUploadFile, useUsers } from "../../queries";
import { Button } from "../ui/button";

/** The column this list is ORDERED BY (api: services/files.ts's
 * `(created_at, id)` descending), which is the only one the arrivals count may
 * read. At module scope so it keeps one identity across renders. */
const createdAtOf = (file: FileMeta): string => file.createdAt;

export interface FilesProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

/**
 * Branches on ApiError.code (never message text -- see src/api.ts) to give
 * the one upload failure the spec calls out (413 "too_large") a friendlier
 * line; any other server-reported code falls back to its already-readable
 * message (toApiError in api.ts already resolves that from the response
 * body).
 */
function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "too_large") return "That file is larger than the 50MB upload limit.";
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * A record's Files tab.
 *
 * =====================================================================
 * THE FILES LIST DOES NOT MOVE UNDER THE READER (v1.7.2)
 * =====================================================================
 *
 * THE RULE, AND THE MECHANISM, ARE notes.tsx's -- the two tabs are the same
 * shape and its header carries the full argument, including every alternative
 * that was rejected and what a whole-list fetch changes about the question.
 * What is written here is only what is different, and one thing is.
 *
 * THE ROW HAS A CLICK TARGET, WHICH MAKES THIS THE ACUTE ONE. A note row is
 * text; a file row is a DOWNLOAD LINK, and it is the only way to get a file
 * back out of the rail. Three different writes publish ["files"] to every open
 * browser -- an upload (api: services/files.ts), a quote being raised
 * (services/documents.ts, which writes a files row against the same deal), and
 * an attachment added in the mail composer (which uploads against the record
 * it is composing about) -- and `created_at` is defaultNow() with no way to
 * supply one, so any of them lands at index 0 of a newest-first list and
 * pushes every row down exactly one. A reader who has read down to
 * "contract-signed.pdf" and clicks it gets whatever was above it instead. The
 * timeline shipped this defect with a "View conversation" link; this ships it
 * with somebody's document.
 *
 * NOTHING REFRESHES A HELD ROW HERE EITHER. routes/files.ts exposes POST
 * /api/files, GET /api/files and GET /api/files/:id/download, and no more; the
 * service exports attachFile, listFiles and getFile. A file row cannot be
 * edited or deleted, so it cannot go stale where it stands -- the rule's
 * second clause is satisfied by the data model rather than by code, exactly as
 * on the timeline. (The uploader's name is not held: it comes from the
 * separate ["users"] query and stays live.)
 *
 * THE READER'S OWN WRITES, of which there are more here than anywhere. An
 * upload from the dropzone below is the obvious one, and the other two are the
 * reason this is useOwnWriteNonce rather than an onSuccess in the dropzone's
 * handler: raising a quote happens in the Documents section of the deal page
 * OUTSIDE this rail, and adding an attachment happens on the Mail tab BESIDE
 * it. Neither knows a Files tab exists. A signal that sees this browser's
 * mutations covers all three; a callback covers whichever one somebody
 * remembered -- the same argument that replaced MeetingForm's explicit reset()
 * in v1.7.1.
 */
export function Files({ companyId, contactId, dealId, projectId }: FilesProps) {
  // Keyed because this component does NOT remount when the route params change
  // under it. See notes.tsx.
  const key = identityKey({ companyId, contactId, dealId, projectId });
  const [held, setHeld] = useState<HeldList<FileMeta>>(() => emptyHeldList<FileMeta>(key));
  const {
    data, isLoading, isFetching, isStale, refetch,
  } = useFiles({ companyId, contactId, dealId, projectId });
  const { data: users = [] } = useUsers();
  const uploadFile = useUploadFile();
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  // Take the list once, and only one the query still calls current. The
  // `isStale` guard is at its most necessary on THIS tab: raising a quote
  // invalidates ["files"] from a section of the page that is not the rail, so
  // opening the Files tab afterwards mounts over a cache entry that is present
  // and known to be out of date -- and holding that would put the reader's own
  // quote behind a button for ever. notes.tsx's copy of this effect carries
  // the rest of the reasoning.
  useEffect(() => {
    if (!data || isStale) return;
    setHeld((current) => takeWholeList(current, key, data));
  }, [data, isStale, key]);

  const rows = useMemo(() => (held.key === key ? held.rows : []), [held, key]);

  // Fetch, THEN replace what is held with what came back, in one setState.
  // notes.tsx says why that order and not the other.
  const keyRef = useLatest(key);
  const resnapshot = useCallback(() => {
    void refetch().then(({ data: fresh }) => {
      if (fresh === undefined) return;
      setHeld({ key: keyRef.current, rows: fresh });
    });
  }, [refetch, keyRef]);

  // The reader's own upload, quote or mail attachment -- never held back. Only
  // a CHANGE means anything, so the mount pass is skipped.
  const ownWrite = useOwnWriteNonce();
  const seenOwnWrite = useRef(ownWrite);
  useEffect(() => {
    if (seenOwnWrite.current === ownWrite) return;
    seenOwnWrite.current = ownWrite;
    resnapshot();
  }, [ownWrite, resnapshot]);

  // `false` for headHasMore is a fact about this route, not a simplification:
  // the fetch is the whole list, so the count can never be a floor.
  const pending = useMemo(
    () => (data === undefined
      ? { count: 0, atLeast: false }
      : pendingArrivals(rows, data, false, createdAtOf)),
    [data, rows],
  );

  function upload(file: File) {
    if (uploadFile.isPending) return;
    setError(null);
    uploadFile.mutate(
      { file, companyId, contactId, dealId, projectId },
      { onError: (err) => setError(uploadErrorMessage(err)) },
    );
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) upload(file);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    // Single attachment per drop, matching the file-picker: only the first
    // dropped file is uploaded, the rest are silently ignored.
    const file = event.dataTransfer.files?.[0];
    if (file) upload(file);
  }

  return (
    <div data-testid="files" className="flex flex-col gap-4">
      <div
        data-testid="dropzone"
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={clsx(
          "flex flex-col items-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm",
          dragActive ? "border-slate-500 bg-slate-50" : "border-slate-300",
        )}
      >
        <p className="text-slate-500">Drag a file here, or</p>
        <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50">
          Choose file
          <input
            type="file"
            className="hidden"
            onChange={handleInputChange}
            disabled={uploadFile.isPending}
          />
        </label>
      </div>
      {uploadFile.isPending && <p className="text-xs text-slate-400">Uploading...</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {/* MOUNTED ALWAYS, so its live region is announced when it fills, and NOT
          sticky. The reasoning is the timeline's, which renders the same
          control for the same rule. */}
      <div data-testid="files-new" role="status" aria-live="polite" className="empty:hidden">
        {pending.count > 0 && (
          <Button
            variant="outline"
            className="w-full"
            data-testid="files-new-show"
            onClick={resnapshot}
          >
            {newArrivalsLabel(pending, "file", "files")}
          </Button>
        )}
      </div>
      {/* THE LIST'S OWN FETCH, not the upload's -- `uploadFile.isPending` above
          is a MUTATION in flight and says "Uploading...". isFetching joins
          isLoading here for the reason notes.tsx gives: a mount over
          invalidated data holds `data`, is still waiting for the answer it will
          take, and would otherwise show "No files yet" on a record that has
          plenty. See pages/company-detail.tsx's Pipelines section for the note
          on `isLoading` against `isPending`. */}
      {(isLoading || isFetching) && rows.length === 0 && (
        <p className="text-sm text-slate-400">Loading...</p>
      )}
      <ul className="flex flex-col gap-2">
        {/* NOT RE-SORTED HERE. services/files.ts orders `(created_at, id)`
            descending and files.test.ts's "listFiles filters by entity and
            orders newest first" pins it; the re-sort this replaces was by
            createdAt alone over an array already in that order, which a stable
            sort leaves untouched. See notes.tsx, which carried the same dead
            line under the same false comment. */}
        {rows.map((file) => (
          <li
            key={file.id}
            data-testid="file-row"
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            {/*
              THE DOWNLOAD LINK HAS NEVER HAD THE 44px FLOOR, and it is the only
              way to get a file back out of the rail. Measured at 390x664 before
              this line: 64.5 x 17px for "fixture.txt", eleven characters -- an
              inline box one line of text tall, which is under half the platform
              minimum. BOTH AXES, because the width is content: 64.5px is what
              that one filename happens to measure, and a file called "a.pdf"
              would be narrower than the floor on its own.

              EVERY PART OF THE FIX IS SCOPED, INCLUDING THE DISPLAY. A height
              floor does nothing to an inline box, so the element has to become
              a flex one for the floor to bite -- but unscoped that changed the
              DESKTOP hit-box too, from 16.5px to 20px, for no reason anybody
              asked for. The first round left it unscoped and the guard pinned
              the mistake. Below the breakpoint it is a 44px flex target; above
              it, it is the inline link it always was.

              IT IS ALSO WHY THIS TAB HOLDS ITS ROWS STILL (v1.7.2): a 44px
              target that a colleague's upload slides out from under the
              pointer is a bigger target for the wrong file.
            */}
            <a
              href={apiUrl(`/files/${file.id}/download`)}
              className="font-medium text-slate-900 underline hover:text-slate-700 max-md:inline-flex max-md:min-h-11 max-md:min-w-11 max-md:items-center"
            >
              {file.originalName}
            </a>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-400">
              <span>
                {humanSize(file.sizeBytes)} {"\u00B7"} {userMap.get(file.uploaderUserId) ?? "\u2014"}
              </span>
              <span>{new Date(file.createdAt).toLocaleString()}</span>
            </div>
          </li>
        ))}
        {!isLoading && !isFetching && rows.length === 0 && (
          <li data-testid="files-empty" className="text-sm text-slate-400">No files yet</li>
        )}
      </ul>
    </div>
  );
}
