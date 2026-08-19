import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Timeline } from "./timeline";
import { Notes } from "./notes";
import { Files } from "./files";

export interface RailProps {
  companyId?: string;
  contactId?: string;
  dealId?: string;
  projectId?: string;
}

/** Detail-page right rail: Timeline / Notes / Files tabs for one company,
 * contact, deal, or (Phase 3) project. */
export function Rail({ companyId, contactId, dealId, projectId }: RailProps) {
  return (
    <div data-testid="rail">
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
