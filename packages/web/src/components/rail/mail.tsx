import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCompany, useContact, useDeal, useProject } from "../../queries";
import { Composer, type ComposerSeed } from "../mail/composer";
import { ThreadList } from "../mail/thread-list";
import { Button } from "../ui/button";
import { useDialogReturnFocus } from "../ui/dialog-focus";
import { composeGate } from "./mail-lib";

export interface MailRailProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
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
   * THE KEYS ARE NAMED BEFORE THEY ARE FETCHED, and the gate below reads the
   * same names. Every hook in queries.ts is `enabled: id !== ""`, so an empty
   * key is exactly a disabled query -- binding the two to one expression is
   * what stops the gate and the fetch from disagreeing about which hops are
   * live.
   *
   * Each hook is disabled on an empty id, and everything here is normally a
   * cache read: the detail page around this rail has already fetched its own
   * record.
   */
  const dealKey = dealId ?? "";
  const projectKey = projectId ?? "";
  const dealQuery = useDeal(dealKey);
  const projectQuery = useProject(projectKey);
  const deal = dealQuery.data;
  const project = projectQuery.data;
  // A deal's contact/company (and a project's company) stand in for the
  // record's own when composing from those tabs -- a deal has no address of
  // its own, its contact does. A PROJECT REACHES NO CONTACT: it has no
  // contactId of its own and this does not hop through its deal, so a project
  // tab composes with an empty To by construction. Measured, and stated here
  // because v1.2.1's plan and spec both describe a project's chain as
  // "deal -> contact", which is the deal tab's chain and not this one's.
  const contactKey = contactId ?? deal?.contactId ?? "";
  const contactQuery = useContact(contactKey);
  const contact = contactQuery.data;
  const companyKey = companyId ?? deal?.companyId ?? project?.companyId ?? contact?.companyId ?? "";
  const companyQuery = useCompany(companyKey);
  const company = companyQuery.data;

  const contactName = contact === undefined
    ? undefined : `${contact.firstName} ${contact.lastName ?? ""}`.trim();

  /*
   * WHETHER THE SEED CAN BE BUILT YET. compose() reads these four queries at
   * CLICK TIME, and from a deal tab two of them are chained -- the deal, then
   * the contact it names -- so a click landing between them seeds `to: []` and
   * addresses the message to nobody with nothing on screen to say so. See
   * mail-lib.ts for why this is three states rather than a boolean, and
   * e2e/rail-compose.spec.ts for the journeys.
   */
  const gate = composeGate([
    { enabled: dealKey !== "", isPending: dealQuery.isPending, isError: dealQuery.isError },
    { enabled: projectKey !== "", isPending: projectQuery.isPending, isError: projectQuery.isError },
    { enabled: contactKey !== "", isPending: contactQuery.isPending, isError: contactQuery.isError },
    { enabled: companyKey !== "", isPending: companyQuery.isPending, isError: companyQuery.isError },
  ]);

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
      context: {
        contactName, companyName: company?.name,
        // Straight off the record, unchanged and unguessed: a contact with no
        // salutation supplies none, and the placeholder renders as nothing rather
        // than staying visible the way an unfilled name does (see BLANK_MEANS_BLANK).
        contactSalutation: contact?.salutation, contactPronouns: contact?.pronouns,
      },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* The reason the button is off, beside the button. A control disabled
            with nothing on screen to explain it is what v1.1.0 refused when it
            considered this shape for the blank-quote race, and what
            components/document-form.tsx's own gate spells out. */}
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
      {/* A failed hop does NOT disable anything -- an address can be typed by
          hand, and a gate that cannot tell "not yet" from "never" is the one
          v1.1.0 rejected. It says what is missing instead, so an empty To is
          not read as this record's own answer. */}
      {gate === "failed" && (
        <p role="alert" data-testid="mail-compose-error" className="text-xs text-red-600">
          Could not load this record's contact or company, so Compose may open with no recipient.
        </p>
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
