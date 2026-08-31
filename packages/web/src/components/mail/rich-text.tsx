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
  /** Signature: adds HTML after the last block, without moving the caret. */
  appendAtEnd(html: string): void;
  /**
   * Puts the caret at the START of the document without changing a character
   * of it. The start is where a reply's caret belongs: the signature sits at
   * the END, and a message is written above it.
   *
   * SEPARATE FROM appendAtEnd("") RATHER THAN A SPECIAL CASE OF IT, because
   * the two want opposite things from the editor: appendAtEnd exists to leave
   * focus alone, and this exists to take it.
   *
   * ONLY MEANINGFUL AFTER onCreate. TipTap builds the editor asynchronously,
   * so a caller focusing at dialog-open time is addressing an editor that does
   * not exist yet; the composer therefore hangs this off the same editor epoch
   * the signature does rather than off the ref being populated.
   */
  focus(): void;
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
 * both would double-register the same extension name. `autolink` is what
 * makes a typed URL become a link without a toolbar affordance for it.
 *
 * `openOnClick: false` GOVERNS THE EDITOR ONLY, and reads as more than it is.
 * TipTap's click plugin bails on a view that is not editable
 * (`if (!view.editable) return false`, extension-link's clickHandler), so no
 * value of this option changes anything in RichTextView below. A click on a
 * link in the EDITOR stays an edit because of this line; a click on a link in
 * the READ-ONLY view is the browser following an ordinary anchor, which
 * ProseMirror does not intercept -- verified against this exact
 * configuration: the click reaches the document unprevented and the
 * navigation happens, just as it does for an anchor outside any editor.
 *
 * That makes the anchor's own attributes the whole of the read-only
 * behaviour, so they are stated here instead of inherited from the
 * extension's defaults. `target="_blank"` because this CRM is a single-page
 * app: a note's link is an aside, and following it in the same tab would
 * throw away the reader's place (an open form, the rail's tab, a scroll
 * position). `rel="noopener noreferrer"` because that is about where the link
 * GOES rather than who wrote it -- a page opened with target=_blank can
 * otherwise reach back through window.opener. Both are exactly what the API's
 * sanitizer already forces onto stored HTML (api: services/mail-content.ts),
 * so the render and the stored document agree by construction rather than by
 * coincidence. MessageFrame's sandboxed iframe is the mail precaution that
 * does NOT carry over: that one is for documents written by strangers.
 *
 * ONE OF THE TWO IS NOT THE INHERITED VALUE. `target="_blank"` already was
 * the extension's default; `rel` was `noopener noreferrer nofollow`, and
 * `nofollow` is deliberately dropped so the render matches the sanitizer
 * byte for byte. Stating both together is what makes that legible -- a
 * reader diffing this against the extension's defaults would otherwise find
 * one unexplained discrepancy in the comment written to explain the
 * mechanism.
 *
 * BLAST RADIUS: EXTENSIONS is shared with RichTextEditor, so this reaches
 * the mail composer, signatures and templates as well as the read-only
 * view. It changes no stored or sent byte: every producer runs through
 * sanitizeMailHtml, whose simpleTransform overwrites rel and target on
 * every anchor unconditionally, and tiptap parses both attributes from the
 * DOM when rendering stored HTML, so a stored anchor renders as stored
 * regardless of what is configured here.
 */
const EXTENSIONS = [
  StarterKit.configure({ link: false }),
  Link.configure({
    openOnClick: false,
    autolink: true,
    HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
  }),
];

const EDITOR_CLASS = "min-h-[8rem] w-full px-3 py-2 text-sm text-slate-900 focus:outline-none";

// Two complete strings rather than a base plus an "active" fragment, the
// convention this package uses wherever a control has exactly two states.
//
// These are the clearest ICON BUTTONS in the app -- a single letter or a
// bullet each, 24x24 and 19x24 at rest -- and this editor is inside three
// surfaces a phone has to be able to use: the composer (a full-screen sheet),
// the meeting form, and both settings pages.
//
// BOTH AXES, because the label is one glyph and the height alone would leave
// a 19px-wide target. No flex with it: a <button> centres its own content
// whatever its display is, which is why the picker rows and the deal
// suggestions were floored with the bare utilities too. (A non-button that
// needs the same floor does need the centring -- see ui/select.tsx.)
const TOOLBAR_BUTTON_TOUCH = "max-md:min-h-11 max-md:min-w-11";
const toolbarButtonClass =
  `rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 ${TOOLBAR_BUTTON_TOUCH}`;
const activeToolbarButtonClass =
  `rounded bg-slate-200 px-2 py-1 text-xs font-medium text-slate-900 ${TOOLBAR_BUTTON_TOUCH}`;

/**
 * Read-only rendering of HTML this app itself produced: meeting notes
 * (Phase 5), which are written in the editor below and sanitized server-side
 * on write with the shared `sanitizeMailHtml` profile.
 *
 * NOT `dangerouslySetInnerHTML`, which appears nowhere in this codebase and
 * should not start here. TipTap parses the HTML into a ProseMirror document
 * against EXTENSIONS' schema and renders that -- so anything the schema does
 * not know is dropped on the way in, which makes the render a second,
 * independent narrowing after the server's sanitizer rather than a raw
 * injection point that trusts it completely.
 *
 * Not MessageFrame either: that iframe (with its no-scripts sandbox and
 * injected CSP) exists for mail, which arrives from strangers. Meeting notes
 * are written by authenticated users of this CRM through the editor below,
 * and a fixed-height sandboxed frame would be a strange way to show three
 * lines of notes in a rail.
 *
 * `content` is read ONCE, like the editor's `initialHtml` -- a caller whose
 * HTML changes remounts this (meetings.tsx keys it on the meeting's
 * updatedAt).
 *
 * `ariaLabel` brings `role="region"` with it, which is what makes the label
 * count: the editor above can carry a bare aria-label because a
 * contenteditable is a textbox and takes one, while this renders as a plain
 * container that an unlabelled name would simply not be announced on. A named
 * region is also how a screen reader reaches the notes without walking the
 * whole rail.
 */
export function RichTextView({ html, className, testId, ariaLabel }: {
  html: string;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const editorProps = useMemo(() => ({
    attributes: {
      class: "text-sm text-slate-900 focus:outline-none",
      ...(ariaLabel !== undefined ? { role: "region", "aria-label": ariaLabel } : {}),
      ...(testId !== undefined ? { "data-testid": testId } : {}),
    },
  }), [ariaLabel, testId]);

  const editor = useEditor({ extensions: EXTENSIONS, content: html, editable: false, editorProps });

  return (
    <div className={clsx("text-sm text-slate-900", className)}>
      <EditorContent editor={editor} />
    </div>
  );
}

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
      appendAtEnd(html: string) {
        if (editor === null) return;
        // insertContentAt(end), not focus("end") + insertContent: appending a
        // signature must not yank the caret (or the page's focus) out of
        // whichever field the user is actually in.
        //
        // `updateSelection: false` IS PART OF THAT SENTENCE AND WAS MISSING,
        // which is a real defect this line's own comment did not describe.
        // TipTap's insertContentAt updates the selection BY DEFAULT, so the
        // append left the caret after the inserted signature -- it moved the
        // CARET while leaving DOM focus alone, and the comment above only ever
        // covered the second half. Measured with a reply focused on open and
        // typed into immediately: "TOPLINE" arrived as
        // "-- Vriendelijke groet, s302227TOPLINE", inside the signature,
        // instead of at the top of the message.
        //
        // It could not be SEEN before v1.2.0 because nothing had put a caret
        // in this editor by the time the signature landed -- the composer
        // opened with focus on the dialog's Close button or the From combobox.
        // IT WAS STILL REACHABLE, AND STILL IS NOT COVERED BY A TEST: switching
        // accounts mid-message appends the new signature, and without this
        // option that moves a typing user's caret to the end of it. THAT PATH
        // NOW HAS ITS OWN TEST: e2e/composer-focus.spec.ts's account-switch
        // journey builds two sendable accounts over the API, types, switches,
        // and types again -- so this line fails on its own mutation, without
        // help from focus() below. (An earlier version of this comment said no
        // journey could build two accounts. The fixture that builds one was in
        // the same commit.)
        editor.chain().insertContentAt(editor.state.doc.content.size, html, { updateSelection: false }).run();
      },
      focus() {
        // "start", not the current selection. The only thing this editor is
        // focused on open for is a REPLY, where the message is written above
        // the signature the append has just put at the end, so the position is
        // stated rather than inherited.
        //
        // A DELIBERATELY KEPT REDUNDANCY, AND DEAD-EQUIVALENT TODAY. With
        // updateSelection:false above, the selection of a document nobody has
        // typed in is already at the start, so focus() and focus("start")
        // resolve to the same position in every state this app can reach --
        // including a reply, which seeds NO body at all (conversation.tsx's
        // openReply sets bodyHtml nowhere; only a forward quotes an original,
        // and a forward focuses To).
        //
        // MUTATION-TESTED, AND THE ANSWER CHANGED WHEN THE SUITE DID. Reverting
        // only this to focus() still passes the whole suite: nothing is
        // asserted that the two spellings can tell apart. Reverting only
        // updateSelection:false USED to pass and no longer does -- the
        // account-switch journey in e2e/composer-focus.spec.ts, added in the
        // same commit as this comment, catches it on its own. An earlier draft
        // of these lines said both mutations survived alone, which was true of
        // the suite it was written against and false of the one it shipped in.
        //
        // So the redundancy is one-sided: the option defends itself, and this
        // stays only because stating the caret's position costs a word while
        // inheriting it costs an argument. A reader who drops it will not be
        // stopped by the suite, and that is the honest position rather than a
        // claim that the two diverge somewhere.
        editor?.chain().focus("start").run();
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
