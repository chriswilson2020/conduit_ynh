import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useContact, useDeal } from "../../queries";
import { Composer, type ComposerSeed } from "../mail/composer";
import { ThreadList } from "../mail/thread-list";
import { Button } from "../ui/button";
import { useDialogReturnFocus } from "../ui/dialog-focus";
import { composeGate, stalledHops, type ComposeHop } from "./mail-lib";

export interface MailRailProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

/**
 * One hop with the refetch already bound to it.
 *
 * BOUND HERE RATHER THAN HANDED TO mail-lib, because each hook's `refetch` has
 * its own return type and a heterogeneous array of the
 * query results would make `hop.refetch()` a call on a union of signatures. A
 * `() => void` per hop keeps the lib free of TanStack's types, and the three
 * fields the gate reads are copied across by name rather than by spreading a
 * result whose other twenty are none of the lib's business.
 */
interface RailHop extends ComposeHop {
  readonly retry: () => void;
}

/**
 * A record's Mail tab: the conversations linked to this company, contact,
 * deal or project, and a Compose button already addressed and linked to it.
 *
 * The list is the inbox's own thread-list with a record filter, and a row
 * opens the conversation in the INBOX (`/mail?thread=<id>`) rather than
 * rendering a second conversation view inside a third of a detail page. The
 * rail is the place to see that mail exists and to start some; reading it is
 * the inbox's job.
 */
export function MailRail({ companyId, contactId, dealId, projectId }: MailRailProps) {
  const navigate = useNavigate();
  const [seed, setSeed] = useState<ComposerSeed | null>(null);

  /*
   * THE KEYS ARE NAMED BEFORE THEY ARE FETCHED, one expression per hop, so
   * nothing downstream can disagree about which id is being asked for.
   *
   * Every hook in queries.ts is `enabled: id !== ""`, and that predicate is
   * deliberately NOT restated below: a disabled query reports the same three
   * fields as one nobody asked for, so the gate ignores it without being told
   * to. See mail-lib.ts's ComposeHop for the measurement that retired the flag
   * this used to pass.
   *
   * Everything here is normally a cache read: the detail page around this rail
   * has already fetched its own record.
   */
  const dealKey = dealId ?? "";
  const dealQuery = useDeal(dealKey);
  const deal = dealQuery.data;
  // A deal's contact stands in for the record's own when composing from that
  // tab -- a deal has no address of its own, its contact does. A PROJECT
  // REACHES NO CONTACT: it has no contactId of its own and this does not hop
  // through its deal, so a project tab composes with an empty To by
  // construction. Measured, and stated here because v1.2.1's plan and spec both
  // describe a project's chain as "deal -> contact", which is the deal tab's
  // chain and not this one's.
  const contactKey = contactId ?? deal?.contactId ?? "";
  const contactQuery = useContact(contactKey);
  const contact = contactQuery.data;

  const contactName = contact === undefined
    ? undefined : `${contact.firstName} ${contact.lastName ?? ""}`.trim();

  /*
   * WHETHER THE SEED CAN BE BUILT YET. compose() reads these queries at CLICK
   * TIME, and from a deal tab they are chained -- the deal, then the
   * contact it names -- so a click landing between them seeds `to: []` and
   * addresses the message to nobody with nothing on screen to say so. See
   * mail-lib.ts for what each of the three states means and what was measured
   * to arrive at them, and e2e/rail-compose.spec.ts for the journeys.
   *
   * THE GATE IS EXACTLY THE SEED'S OWN CHAIN, and it was narrowed to that in
   * v1.2.2. It used to carry a project hop and a company hop as well, which fed
   * `context.companyName` for the mail merge; that merge went with the mail
   * templates, so `to` is the only seed field any query still decides and
   * deal -> contact is the only chain that reaches it. A control held shut by
   * data nothing reads is a slower button and nothing else, so those two were
   * dropped rather than kept for symmetry -- which means Compose comes live
   * SOONER on a deal tab, and immediately on a project or company one.
   * e2e/rail-compose.spec.ts holds each of the dropped hops open and asserts
   * that it no longer waits.
   */
  const hops: readonly RailHop[] = [
    {
      data: dealQuery.data, isError: dealQuery.isError, fetchStatus: dealQuery.fetchStatus,
      retry: () => { void dealQuery.refetch(); },
    },
    {
      data: contactQuery.data, isError: contactQuery.isError, fetchStatus: contactQuery.fetchStatus,
      retry: () => { void contactQuery.refetch(); },
    },
  ];
  const gate = composeGate(hops);

  // The Compose button is where the composer's close puts the caret back --
  // see components/ui/dialog-focus.ts.
  const returnFocus = useDialogReturnFocus();

  function compose(trigger: HTMLElement) {
    returnFocus.capture(trigger);
    setSeed({
      // The record's first address, when the record has one. A company has
      // none (companies carry a domain, not a mailbox), so composing from a
      // company tab opens with an empty To -- deliberately, rather than
      // guessing an address from the domain.
      to: contact?.emails[0] === undefined ? [] : [{ address: contact.emails[0], name: contactName ?? null }],
      // The link this tab is filtered by, so the new thread lands back here --
      // and so the composer's attach control is enabled (POST /api/files needs
      // a record to file the upload against).
      links: { companyId, contactId, dealId, projectId },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* The reason the button is off, beside the button. A control disabled
            with nothing on screen to explain it is what v1.1.0 refused when it
            considered this shape for the blank-quote race, and what the reason
            line in components/document-form.tsx exists to avoid. */}
        {gate === "resolving" && (
          <p data-testid="mail-compose-pending" className="text-xs text-slate-500">
            Fetching this record's details...
          </p>
        )}
        <Button
          variant="outline"
          data-testid="mail-compose"
          disabled={gate === "resolving"}
          onClick={(event) => compose(event.currentTarget)}
        >
          Compose
        </Button>
      </div>
      {/* A failed hop does NOT disable anything -- a gate that cannot tell "not
          yet" from "never" is the one v1.1.0 rejected -- so it says what is
          missing and offers the way back, in the shape this rail's own
          neighbours use (see timeline.tsx and meetings.tsx, which pair the same
          alert with the same Retry). The Retry is what gets the recipient
          without a page reload; typing the address by hand is the other way,
          and this says which one is missing rather than opening silently. */}
      {gate === "failed" && (
        <div className="flex items-center gap-2">
          <p role="alert" data-testid="mail-compose-error" className="text-xs text-red-600">
            Could not load this record's contact, so Compose may open with no recipient.
          </p>
          <Button
            variant="outline"
            className="px-2 py-1 text-xs"
            data-testid="mail-compose-retry"
            onClick={() => { for (const hop of stalledHops(hops)) hop.retry(); }}
          >
            Retry
          </Button>
        </div>
      )}
      <ThreadList
        filters={{ companyId, contactId, dealId, projectId }}
        onSelect={(threadId) => { void navigate({ to: "/mail", search: { thread: threadId } }); }}
        limit={10}
        emptyLabel="No conversations linked to this record"
      />
      <Composer
        open={seed !== null}
        onOpenChange={(open) => { if (!open) setSeed(null); }}
        seed={seed ?? undefined}
        returnFocus={returnFocus}
      />
    </div>
  );
}
