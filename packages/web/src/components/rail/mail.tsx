import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useCompany, useContact, useDeal, useProject } from "../../queries";
import { Composer, type ComposerSeed } from "../mail/composer";
import { ThreadList } from "../mail/thread-list";
import { Button } from "../ui/button";

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

  // Each hook is disabled on an empty id, and everything here is normally a
  // cache read: the detail page around this rail has already fetched its own
  // record.
  const { data: deal } = useDeal(dealId ?? "");
  const { data: project } = useProject(projectId ?? "");
  // A deal's contact/company (and a project's company) stand in for the
  // record's own when composing from those tabs -- a deal has no address of
  // its own, its contact does.
  const { data: contact } = useContact(contactId ?? deal?.contactId ?? "");
  const { data: company } = useCompany(
    companyId ?? deal?.companyId ?? project?.companyId ?? contact?.companyId ?? "",
  );

  const contactName = contact === undefined
    ? undefined : `${contact.firstName} ${contact.lastName ?? ""}`.trim();

  function compose() {
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
        // salutation supplies none, and the placeholder stays visible.
        contactSalutation: contact?.salutation, contactPronouns: contact?.pronouns,
      },
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="outline" data-testid="mail-compose" onClick={compose}>
          Compose
        </Button>
      </div>
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
      />
    </div>
  );
}
