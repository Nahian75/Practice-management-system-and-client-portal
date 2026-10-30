'use client';
import {useState,type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {putJson,messagesOf} from '@/lib/requests';
import {ErrorSummary} from '@/components/error-summary';
export function PerformanceForm({minutes}:{minutes:number|null}){
 const[busy,setBusy]=useState(false),[errors,setErrors]=useState<string[]>(),[saved,setSaved]=useState(false);const router=useRouter();
 async function save(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);const raw=String(data.get('hours')).trim();const value=raw===''?null:Math.round(Number(raw)*60);setBusy(true);setErrors(undefined);setSaved(false);try{const response=await putJson('/api/workspace/performance-target',{dailyTargetMinutes:value});if(!response.ok){setErrors(await messagesOf(response));return;}setSaved(true);router.refresh();}catch{setErrors(['Could not save your target. Try again.']);}finally{setBusy(false);}}
 return <form className="workspace-card" onSubmit={save}>{errors&&<ErrorSummary messages={errors}/>}<div className="field"><label className="label" htmlFor="daily-hours">Daily billable-hours target</label><input className="input input-short" type="number" id="daily-hours" name="hours" min="0.25" max="24" step="0.05" defaultValue={minutes===null?'':minutes/60}/><p className="hint">Applied to weekdays. Leave blank to remove your target. Holidays are not deducted automatically.</p></div><button className="button" disabled={busy}>{busy?'Saving…':'Save target'}</button>{saved&&<p className="notice" role="status">Your performance target was saved.</p>}</form>;
}
