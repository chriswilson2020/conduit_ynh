import { useMemo, useState } from "react";
import { useCreateNote, useNotes, useUsers } from "../../queries";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface NotesProps {
  companyId?: string;
  contactId?: string;
}

export function Notes({ companyId, contactId }: NotesProps) {
  const [draft, setDraft] = useState("");
  const { data: notes = [] } = useNotes({ companyId, contactId });
  const { data: users = [] } = useUsers();
  const createNote = useCreateNote();
  const userMap = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users]);

  // The API doesn't guarantee note order, so newest-first is enforced here.
  const sorted = useMemo(
    () => [...notes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [notes],
  );

  function handleAdd() {
    const body = draft.trim();
    if (body === "") return;
    createNote.mutate({ body, companyId, contactId }, { onSuccess: () => setDraft("") });
  }

  return (
    <div data-testid="notes" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a note..."
          rows={3}
          disabled={createNote.isPending}
        />
        <div className="flex items-center justify-between gap-2">
          {createNote.isError && <p className="text-xs text-red-600">{createNote.error.message}</p>}
          <Button
            data-testid="add-note"
            className="ml-auto"
            onClick={handleAdd}
            disabled={createNote.isPending || draft.trim() === ""}
          >
            Add note
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-3">
        {sorted.map((note) => (
          <li key={note.id} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-slate-400">
              <span className="font-medium text-slate-600">{userMap.get(note.authorUserId) ?? "\u2014"}</span>
              <span>{new Date(note.createdAt).toLocaleString()}</span>
            </div>
            <p className="whitespace-pre-wrap text-slate-900">{note.body}</p>
          </li>
        ))}
        {sorted.length === 0 && <li className="text-sm text-slate-400">No notes yet</li>}
      </ul>
    </div>
  );
}
