import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Timeline } from "./timeline";
import { Notes } from "./notes";
import { Files } from "./files";
import { MailRail } from "./mail";
import { Meetings } from "./meetings";

export interface RailProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

/** Detail-page right rail: Timeline / Notes / Files / Mail / Meetings tabs for
 * one company, contact, deal, or (Phase 3) project.
 *
 * Mail joined the rail in Phase 4 rather than becoming a section on each of
 * the four detail pages: this component IS those pages' shared tab strip, so
 * one tab here is the same feature on all four, with the same filter shape
 * they already pass for notes and files. Meetings joined it in Phase 5 for the
 * same reason.
 *
 * THE TABS ARE CONTROLLED, and the selected meeting lives here rather than in
 * the Meetings tab, because a Timeline entry can open a meeting: a `met` entry
 * (and a follow-up task's creation entry) carries the meeting's id, and
 * v0.9.0 ships no meetings route to navigate to -- a meeting is only reachable
 * inside this tab strip. So the rail, which owns both tabs, is the only thing
 * that can honour such a click, and it does it by switching tabs and handing
 * the id down. The same Timeline rendered in the task drawer gets no handler
 * and renders those entries as plain text.
 */
export function Rail({ companyId, contactId, dealId, projectId }: RailProps) {
  const [tab, setTab] = useState("timeline");

  // THE SELECTION CARRIES THE RECORD IT BELONGS TO, and is read back only for
  // that record. This component does NOT remount when the route params change
  // under it (/companies/a -> /companies/b is one mounted CompanyDetailPage
  // with new props), so a plain `string | null` here would leave company a's
  // meeting open on company b's tab -- the same shape of bug the timeline's
  // page accumulator solves by keying on its filter set, and solved the same
  // way rather than by an effect that has to remember to fire.
  const recordKey = `${companyId ?? ""}|${contactId ?? ""}|${dealId ?? ""}|${projectId ?? ""}`;
  const [selection, setSelection] = useState<{ recordKey: string; meetingId: string | null }>(
    { recordKey, meetingId: null },
  );
  const meetingId = selection.recordKey === recordKey ? selection.meetingId : null;
  const selectMeeting = (id: string | null) => setSelection({ recordKey, meetingId: id });

  return (
    <div data-testid="rail">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="mail" testId="mail-tab">Mail</TabsTrigger>
          <TabsTrigger value="meetings" testId="meetings-tab">Meetings</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Timeline
            companyId={companyId}
            contactId={contactId}
            dealId={dealId}
            projectId={projectId}
            onOpenMeeting={(id) => {
              selectMeeting(id);
              setTab("meetings");
            }}
          />
        </TabsContent>
        <TabsContent value="notes">
          <Notes companyId={companyId} contactId={contactId} dealId={dealId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="files">
          <Files companyId={companyId} contactId={contactId} dealId={dealId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="mail">
          <MailRail companyId={companyId} contactId={contactId} dealId={dealId} projectId={projectId} />
        </TabsContent>
        <TabsContent value="meetings">
          <Meetings
            companyId={companyId}
            contactId={contactId}
            dealId={dealId}
            projectId={projectId}
            selectedMeetingId={meetingId}
            onSelectMeeting={selectMeeting}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
