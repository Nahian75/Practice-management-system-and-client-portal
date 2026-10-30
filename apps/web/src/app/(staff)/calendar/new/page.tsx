import {apiGet} from '@/lib/api';
import type {MatterSummary} from '@/lib/matters';
import {WorkspaceHeading} from '@/components/workspace-page';
import {NoAccess} from '@/components/no-access';
import {CalendarEventForm} from '../calendar-actions';
export const metadata={title:'New calendar event'};
export default async function Page(){const list=await apiGet<{matters:MatterSummary[]}>('/matters');if(list.status===403)return <NoAccess what="calendar events"/>;return <><WorkspaceHeading title="New calendar event" description="Plan a personal appointment or reserve time for a matter."/><CalendarEventForm matters={list.body?.matters??[]}/></>;}
