import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

export interface FieldCardField {
  name: string;
  label: string;
  value: string | null;
  editable?: boolean;
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

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>, name: string) {
    if (event.key === "Enter") {
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
                  <Input
                    autoFocus
                    value={draft}
                    disabled={isSaving}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commit(field.name)}
                    onKeyDown={(event) => handleKeyDown(event, field.name)}
                  />
                ) : (
                  <span
                    className={
                      field.editable && !archived
                        ? "block cursor-pointer rounded px-2 py-2 hover:bg-slate-50"
                        : "block px-2 py-2"
                    }
                    onClick={() => startEdit(field)}
                  >
                    {field.value === null || field.value === "" ? "\u2014" : field.value}
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
