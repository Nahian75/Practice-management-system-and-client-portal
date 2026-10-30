import Link from 'next/link';
import { apiGet } from '@/lib/api';
import type { Matter,MatterSummary } from '@/lib/matters';
import { WorkspaceHeading,WorkspaceEmpty } from './workspace-page';
import { AddTaskForm } from '@/app/(staff)/matters/[matterId]/add-task-form';
import { AddDocumentForm } from '@/app/(staff)/matters/[matterId]/add-document-form';
import { TimeEntryForm } from '@/app/(staff)/matters/[matterId]/time-entry-form';
export async function NewWorkPage({kind,searchParams}:{kind:'tasks'|'documents'|'activities';searchParams:Promise<{matter?:string;minutes?:string}>}){
 const {matter:selection,minutes}=await searchParams;const initialMinutes=typeof minutes==='string'&&/^\d{1,4}$/.test(minutes)&&Number(minutes)>=1&&Number(minutes)<=1440?Number(minutes):undefined;const matterId=typeof selection==='string'&&/^[a-f0-9-]{36}$/i.test(selection)?selection:undefined;
 const list=await apiGet<{matters:MatterSummary[];next:string|null}>('/matters');
 const matter=matterId?await apiGet<Matter>(`/matters/${matterId}`):undefined;
 const title={tasks:'New task',documents:'Upload document',activities:'Record time'}[kind];
 return <><WorkspaceHeading title={title} description="Choose the matter for this work. The same team and compliance rules apply throughout the workspace."/><div className="workspace-card"><form className="workspace-filters">{initialMinutes&&<input type="hidden" name="minutes" value={initialMinutes}/>}<label htmlFor="work-matter">Matter<select id="work-matter" name="matter" defaultValue={matterId??''} required><option value="" disabled>Select a matter</option>{matter?.body&&!list.body?.matters.some(m=>m.id===matterId)&&<option value={matterId}>{matter.body.reference}: {matter.body.title}</option>}{list.body?.matters.filter(m=>m.status==='open').map(m=><option key={m.id} value={m.id}>{m.reference}: {m.title}</option>)}</select></label><button className="button button-secondary">Continue</button></form><p className="workspace-guide-note">Only open matters are listed. You can also open a record from <Link href="/matters">Matters</Link> and use its existing task, upload and time forms.</p>{matter?.body?(kind==='tasks'?<AddTaskForm matterId={matterId!} team={matter.body.team}/>:kind==='documents'?<AddDocumentForm matterId={matterId!}/>:<TimeEntryForm matterId={matterId!} initialMinutes={initialMinutes}/>):matterId?<p role="alert">This matter is unavailable to your account.</p>:<WorkspaceEmpty title="Select a matter to continue">Your task, document or time entry will be saved to that matter.</WorkspaceEmpty>}</div></>;
}
