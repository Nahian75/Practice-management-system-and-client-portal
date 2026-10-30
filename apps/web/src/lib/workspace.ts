export interface WorkspacePage<T>{items:T[];next:string|null}
export interface WorkTask{id:string;title:string;status:'open'|'completed'|'cancelled';priority:'low'|'normal'|'high'|'urgent';dueOn:string|null;matterId:string;matterReference:string;matterTitle:string;assignee:string;assigneeId:string}
export interface WorkDocument{id:string;title:string;category:string;matterId:string;matterReference:string;matterTitle:string;fileName:string;sizeBytes:number;version:number;uploadedAt:string;sharedWithClient:boolean}
export interface WorkActivity{id:string;description:string;workedOn:string;minutes:number;voided:boolean;matterId:string;matterReference:string;matterTitle:string;worker:string}
export interface CalendarEvent{id:string;title:string;description:string|null;startsAt:string;endsAt:string;matterId:string|null;matterReference:string|null}
export interface PerformancePeriod{key:string;label:string;from:string;to:string;minutes:number;targetMinutes:number|null;billedPence:string;unbilledPence:string}
export interface PerformanceMetrics{scope:'personal'|'firm';asOf:string;dailyTargetMinutes:number|null;periods:PerformancePeriod[]}
export interface BillingMetrics{draftCount:number;draftPence:string;issuedCount:number;issuedPence:string;creditCount:number;creditPence:string}
export const londonDay=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
