import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Timeline } from "./timeline";
import { Notes } from "./notes";
import { Files } from "./files";

export interface RailProps {
  companyId?: string;
  contactId?: string;
}

/** Detail-page right rail: Timeline / Notes / Files tabs for one company or contact. */
export function Rail({ companyId, contactId }: RailProps) {
  return (
    <div data-testid="rail">
      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline">
          <Timeline companyId={companyId} contactId={contactId} />
        </TabsContent>
        <TabsContent value="notes">
          <Notes companyId={companyId} contactId={contactId} />
        </TabsContent>
        <TabsContent value="files">
          <Files companyId={companyId} contactId={contactId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
