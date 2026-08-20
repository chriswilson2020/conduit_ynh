import { forwardRef, useImperativeHandle, useMemo } from "react";
import Link from "@tiptap/extension-link";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { clsx } from "clsx";

/**
 * The imperative operations the composer needs that a value/onChange pair
 * cannot express, because both depend on the editor's own selection state.
 * Everything else about this editor is ordinary controlled-ish React: it is
 * seeded once from `initialHtml` and reports every change through `onChange`.
 */
export interface RichTextHandle {
  /** Template insertion: drops HTML in at the caret. */
  insertAtCursor(html: string): void;
  /** Signature: adds HTML after the last block, without moving the caret. */
  appendAtEnd(html: string): void;
}

export interface RichTextEditorProps {
  /**
   * Initial content, read ONCE when the editor mounts -- TipTap owns the
   * document from then on. Callers that need to reset the content (the
   * composer, opening on a new seed) remount the editor instead of changing
   * this, which the dialog does for free: Radix unmounts its portal content
   * on close, so every open is a fresh editor.
   */
  initialHtml?: string;
  onChange: (html: string) => void;
  /**
   * Fired once the editor instance exists and its document is mounted. The
   * composer hangs its signature append off this rather than off a ref being
   * populated, so nothing depends on when TipTap happens to fill the ref.
   */
  onCreate?: () => void;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}

/**
 * Module-level, and never rebuilt per render: useEditor calls setOptions on
 * every render it sees new options, so a fresh array here would re-register
 * the whole extension set on every keystroke.
 *
 * StarterKit v3 already BUNDLES the Link extension, so its copy is switched
 * off (`link: false`) and a configured one registered alongside -- registering
 * both would double-register the same extension name. `openOnClick: false`
 * keeps a click inside the editor an edit rather than a navigation;
 * `autolink` is what makes a typed URL become a link without a toolbar
 * affordance for it.
 */
const EXTENSIONS = [
  StarterKit.configure({ link: false }),
  Link.configure({ openOnClick: false, autolink: true }),
];

const EDITOR_CLASS = "min-h-[8rem] w-full px-3 py-2 text-sm text-slate-900 focus:outline-none";

const toolbarButtonClass =
  "rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50";
const activeToolbarButtonClass = "rounded bg-slate-200 px-2 py-1 text-xs font-medium text-slate-900";

/**
 * The one rich-text editor in the app (Phase 4's first TipTap use): message
 * bodies, per-account signatures and email templates all render through it.
 * StarterKit + Link, and nothing else -- see EXTENSIONS above.
 *
 * All output HTML is sanitized SERVER-side on every write path (signatures,
 * templates and compose bodies all run through mail-content.ts's shared
 * sanitizer), so this editor never has to be the security boundary.
 */
export const RichTextEditor = forwardRef<RichTextHandle, RichTextEditorProps>(
  function RichTextEditor({ initialHtml = "", onChange, onCreate, className, testId, ariaLabel }, ref) {
    // Memoised for the same reason EXTENSIONS is hoisted: a new object here
    // every render is a setOptions call every keystroke.
    const editorProps = useMemo(() => ({
      attributes: {
        class: EDITOR_CLASS,
        ...(ariaLabel !== undefined ? { "aria-label": ariaLabel } : {}),
        ...(testId !== undefined ? { "data-testid": testId } : {}),
      },
    }), [ariaLabel, testId]);

    const editor = useEditor({
      extensions: EXTENSIONS,
      content: initialHtml,
      editorProps,
      onCreate: () => onCreate?.(),
      onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
    });

    useImperativeHandle(ref, () => ({
      insertAtCursor(html: string) {
        editor?.chain().focus().insertContent(html).run();
      },
      appendAtEnd(html: string) {
        if (editor === null) return;
        // insertContentAt(end), not focus("end") + insertContent: appending a
        // signature must not yank the caret (or the page's focus) out of
        // whichever field the user is actually in.
        editor.chain().insertContentAt(editor.state.doc.content.size, html).run();
      },
    }), [editor]);

    return (
      <div className={clsx("rounded-md border border-slate-300 bg-white", className)}>
        <div className="flex gap-1 border-b border-slate-200 px-2 py-1">
          <button
            type="button"
            aria-label="Bold"
            className={editor?.isActive("bold") === true ? activeToolbarButtonClass : toolbarButtonClass}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            B
          </button>
          <button
            type="button"
            aria-label="Italic"
            className={editor?.isActive("italic") === true ? activeToolbarButtonClass : toolbarButtonClass}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            I
          </button>
          <button
            type="button"
            aria-label="Bulleted list"
            className={editor?.isActive("bulletList") === true ? activeToolbarButtonClass : toolbarButtonClass}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            {"\u2022"}
          </button>
        </div>
        <EditorContent editor={editor} />
      </div>
    );
  },
);
