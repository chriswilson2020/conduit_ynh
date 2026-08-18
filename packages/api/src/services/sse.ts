import type { SseHint } from "@conduit/shared";

type Subscriber = (hint: SseHint) => void;

const subscribers = new Set<Subscriber>();

/**
 * Fan a hint out to every live subscriber. Never throws: a broken subscriber is
 * logged and dropped rather than allowed to break the publisher, which is always a
 * service inside a request -- an SSE client write failing must not turn into a 500
 * for whichever mutation happened to publish after it.
 *
 * Publishing happens AFTER the caller's transaction commits (the caller's job, not
 * this function's -- see each service's mutators) -- a hint for a rolled-back write
 * would make clients refetch data that never changed, or worse, cache the absence of
 * data that then appears.
 */
export function publish(hint: SseHint): void {
  for (const fn of subscribers) {
    try {
      fn(hint);
    } catch (error) {
      subscribers.delete(fn);
      console.error("sse: subscriber threw, dropping it", error);
    }
  }
}

/** Register a subscriber; returns an unsubscribe function. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Test-only. */
export function subscriberCount(): number {
  return subscribers.size;
}
