import { useMemo } from "react";
import { messageFrameCsp, messageFrameSrcdoc } from "./mail-lib";

export interface MessageFrameProps {
  /** The message's body_html, as the API served it: already sanitized at
   * ingest, with its cid: images resolved to same-origin attachment routes. */
  html: string;
  /** Flipped by the conversation's per-thread "Load remote images" button. */
  remoteImages: boolean;
  testId?: string;
}

/**
 * One message body, isolated in an iframe.
 *
 * THE SANDBOX IS `allow-same-origin`, AND NOTHING ELSE. Never add
 * `allow-scripts` (coordinator ruling, 20 Aug; the plan and the spec's
 * Frontend section both carry the reasoning): an EMPTY sandbox would give the
 * frame an opaque origin, its subresource loads would carry no SameSite
 * cookies, and SSOwat would bounce the cookieless inline-image requests to its
 * login page -- so inline images would never render. Same-origin plus no
 * scripts plus the injected CSP (mail-lib's messageFrameCsp) is the accepted
 * trade, and it is why GET /api/mail/attachments/:id/inline is an ordinary
 * authenticated route rather than a signed one.
 *
 * SIZING IS FIXED, deliberately. Auto-sizing an iframe to its content needs a
 * script INSIDE the frame to measure and post the height out, and there are no
 * scripts in here by construction -- so the frame gets a fixed height and mail
 * longer than that scrolls within it, rather than a measurement that cannot
 * exist. (The plan says the same thing: "no in-frame measurement".)
 *
 * LINKS INSIDE A MESSAGE ARE INERT in this release, as a consequence of the
 * same sandbox: the sanitizer gives every link target="_blank", and a sandbox
 * without allow-popups blocks that navigation. Opening mail links is a
 * separate decision (allow-popups widens what a hostile message can do), not
 * something to slip in under a rendering component.
 */
export function MessageFrame({ html, remoteImages, testId }: MessageFrameProps) {
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
      title="Message body"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      className="h-[32rem] max-h-[32rem] w-full rounded border border-slate-200 bg-white"
    />
  );
}
