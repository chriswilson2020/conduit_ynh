import { useMemo } from "react";
import { MESSAGE_FRAME_SANDBOX, messageFrameCsp, messageFrameSrcdoc } from "./mail-lib";

export interface MessageFrameProps {
  /** The message's body_html, as the API served it: already sanitized at
   * ingest, with its cid: images resolved to same-origin attachment routes. */
  html: string;
  /** Flipped by the conversation's per-thread "Load remote images" button. */
  remoteImages: boolean;
  testId?: string;
  /** Mirrors the `data-body-kind` the text branch carries, so a test can tell
   * the two renderings apart -- only this one is reachable through a frame
   * locator. */
  bodyKind?: string;
}

/**
 * One message body, isolated in an iframe.
 *
 * THE SANDBOX IS mail-lib's MESSAGE_FRAME_SANDBOX -- same-origin plus the two
 * popup flags, and NEVER `allow-scripts` (coordinator rulings, 20 Aug; that
 * constant's doc comment, the plan and the spec's Frontend section carry the
 * full reasoning). Same-origin is what makes cookie-authenticated inline
 * images load through SSOwat, and is why GET /api/mail/attachments/:id/inline
 * is an ordinary authenticated route rather than a signed one; no scripts plus
 * the injected CSP (mail-lib's messageFrameCsp) is what makes granting the
 * frame this app's origin acceptable.
 *
 * SIZING IS FIXED, deliberately. Auto-sizing an iframe to its content needs a
 * script INSIDE the frame to measure and post the height out, and there are no
 * scripts in here by construction -- so the frame gets a fixed height and mail
 * longer than that scrolls within it, rather than a measurement that cannot
 * exist. (The plan says the same thing: "no in-frame measurement".)
 *
 * LINKS INSIDE A MESSAGE OPEN IN A NEW TAB, like any mail client's: the
 * sanitizer gives every anchor `target="_blank"` and `rel="noopener
 * noreferrer"`, and the sandbox's popup pair is what lets that target actually
 * fire, in an ordinary tab rather than a sandboxed one. Nothing about the
 * links is trusted -- the destination is whatever the message said -- but that
 * is equally true of a link in any inbox, and a link that silently does
 * nothing reads as a broken app.
 */
export function MessageFrame({ html, remoteImages, testId, bodyKind }: MessageFrameProps) {
  const srcDoc = useMemo(() => {
    // window.location.origin, not a hardcoded value: 'self' already covers the
    // app's origin for a same-origin frame, and naming the origin explicitly
    // costs nothing and keeps the policy readable in devtools.
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return messageFrameSrcdoc(html, messageFrameCsp(origin, { remoteImages }));
  }, [html, remoteImages]);

  return (
    <iframe
      data-testid={testId}
      data-body-kind={bodyKind}
      title="Message body"
      sandbox={MESSAGE_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="h-[32rem] max-h-[32rem] w-full rounded border border-slate-200 bg-white"
    />
  );
}
