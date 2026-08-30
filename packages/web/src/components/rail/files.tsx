import { useMemo, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { clsx } from "clsx";
import { ApiError, apiUrl } from "../../api";
import { humanSize } from "../../lib";
import { useFiles, useUploadFile, useUsers } from "../../queries";

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

export function Files({ companyId, contactId, dealId, projectId }: FilesProps) {
  const { data: files = [] } = useFiles({ companyId, contactId, dealId, projectId });
  const { data: users = [] } = useUsers();
  const uploadFile = useUploadFile();
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);
  const sorted = useMemo(
    () => [...files].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [files],
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
      <ul className="flex flex-col gap-2">
        {sorted.map((file) => (
          <li key={file.id} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
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
        {sorted.length === 0 && <li className="text-sm text-slate-400">No files yet</li>}
      </ul>
    </div>
  );
}
