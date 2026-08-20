import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Timeline } from "./timeline";
import { Notes } from "./notes";
import { Files } from "./files";
import { MailRail } from "./mail";

export interface RailProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

/** Detail-page right rail: Timeline / Notes / Files / Mail tabs for one
 * company, contact, deal, or (Phase 3) project.
 *
 * Mail joined the rail in Phase 4 rather than becoming a section on each of
 * the four detail pages: this component IS those pages' shared tab strip, so
 * one tab here is the same feature on all four, with the same filter shape
 * they already pass for notes and files. */
export function Rail({ companyId, contactId, dealId, projectId }: RailProps) {
  return (
    <div data-testid="rail">
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="mail" testId="mail-tab">Mail</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Timeline companyId={companyId} contactId={contactId} dealId={dealId} projectId={projectId} />
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
      </Tabs>
    </div>
  );
}
