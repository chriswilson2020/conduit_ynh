import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { clsx } from "clsx";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

export interface FieldCardField {
  name: string;
  label: string;
  value: string | null;
  editable?: boolean;
  /** Read-only rendering override for the field's non-editing display -- e.g. a
   * formatted currency string ("$1,234.56") while `value` stays the raw,
   * editable representation ("1234.56") that startEdit below seeds the input
   * from. Falls back to `value` itself when omitted (every other page's
   * fields), so this is purely additive for callers that don't need the
   * split. */
  displayValue?: string | null;
  /** Edits through a Textarea instead of a single-line Input -- the task
   * drawer's (Task 8) description field, which unlike every other FieldCard
   * user to date is plain multi-line text, not a short label/amount. Enter
   * no longer commits when true (a multi-line field needs Enter for actual
   * newlines); Escape and blur still do. */
  multiline?: boolean;
}

export interface FieldCardProps {
  fields: FieldCardField[];
  onSave: (name: string, value: string) => void;
  /** When true the card is entirely read-only and shows an Archived badge. */
  archived?: boolean;
  onUnarchive?: () => void;
  /** Name of the field currently being saved, to disable its input. */
  savingField?: string | null;
  /** Per-field inline error (e.g. the API's 400 message), keyed by name. */
  errors?: Partial<Record<string, string>>;
}

/**
 * Definition-list of editable fields. Clicking an editable value swaps it for
 * an Input; Enter or blur commits via onSave, Escape cancels. The field stays
 * in edit mode (input disabled) for the duration of the save so the caller's
 * savingField prop has something to disable -- see the effect below for how
 * it detects "our save just settled" without also swallowing unrelated
 * savingField transitions for other fields.
 */
export function FieldCard({
  fields,
  onSave,
  archived = false,
  onUnarchive,
  savingField = null,
  errors = {},
}: FieldCardProps) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const prevSavingRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevSavingRef.current !== null && savingField === null && prevSavingRef.current === editingField) {
      setEditingField(null);
    }
    prevSavingRef.current = savingField;
  }, [savingField, editingField]);

  function startEdit(field: FieldCardField) {
    if (archived || !field.editable) return;
    setEditingField(field.name);
    setDraft(field.value ?? "");
  }

  function commit(name: string) {
    onSave(name, draft);
  }

  // Shared by the Input and Textarea key handlers below -- Enter commits
  // ONLY for a single-line field (multiline === false); a multiline field
  // needs Enter free for actual newlines, so it commits on blur/Escape only,
  // same as every field already does for Escape.
  function handleKeyDown(
    event: KeyboardEvent<HTMLInputElement> | KeyboardEvent<HTMLTextAreaElement>,
    name: string,
    multiline: boolean,
  ) {
    if (event.key === "Enter" && !multiline) {
      commit(name);
    } else if (event.key === "Escape") {
      setEditingField(null);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      {archived && (
        <div className="flex items-center justify-between border-b border-slate-200 bg-amber-50 px-4 py-2">
          <span data-testid="archived-badge" className="text-sm font-medium text-amber-800">
            Archived
          </span>
          {onUnarchive && (
            <Button variant="outline" onClick={onUnarchive}>
              Unarchive
            </Button>
          )}
        </div>
      )}
      <dl className="divide-y divide-slate-100">
        {fields.map((field) => {
          const isEditing = editingField === field.name;
          const isSaving = savingField === field.name;
          const error = errors[field.name];
          return (
            <div
              key={field.name}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
            >
              <dt className="w-32 shrink-0 pt-2 text-sm font-medium text-slate-500">{field.label}</dt>
              <dd data-testid={`field-${field.name}`} className="flex-1 text-sm text-slate-900">
                {isEditing ? (
                  field.multiline ? (
                    <Textarea
                      autoFocus
                      rows={3}
                      value={draft}
                      disabled={isSaving}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commit(field.name)}
                      onKeyDown={(event) => handleKeyDown(event, field.name, true)}
                    />
                  ) : (
                    <Input
                      autoFocus
                      value={draft}
                      disabled={isSaving}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={() => commit(field.name)}
                      onKeyDown={(event) => handleKeyDown(event, field.name, false)}
                    />
                  )
                ) : (
                  <span
                    className={clsx(
                      "block px-2 py-2",
                      field.editable && !archived && "cursor-pointer rounded hover:bg-slate-50",
                      field.multiline && "whitespace-pre-wrap",
                    )}
                    onClick={() => startEdit(field)}
                  >
                    {(() => {
                      const shown = field.displayValue !== undefined ? field.displayValue : field.value;
                      return shown === null || shown === "" ? "\u2014" : shown;
                    })()}
                  </span>
                )}
                {error && <p className="mt-1 px-2 text-xs text-red-600">{error}</p>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
