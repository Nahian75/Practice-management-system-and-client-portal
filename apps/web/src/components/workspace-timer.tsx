'use client';
import Link from 'next/link';
import {useCallback,useEffect,useRef,useState} from 'react';
import {messagesOf,postJson} from '@/lib/requests';
import {WorkspaceIcon} from './workspace-icon';
type Timer={timerId:string|null;revision:string|null;elapsedMs:number;startedAt:string|null;serverNow:string};
export function WorkspaceTimer({accountId}:{accountId:string}){
 const[timer,setTimer]=useState<Timer>(),[now,setNow]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const offset=useRef(0),sequence=useRef(0),mutating=useRef(false);
 const accept=useCallback((value:Timer)=>{offset.current=Date.parse(value.serverNow)-Date.now();setNow(Date.now());setTimer(value);},[]);
 const refresh=useCallback(async()=>{if(mutating.current)return;const request=++sequence.current;try{const response=await fetch('/api/workspace/timer',{cache:'no-store'});if(!response.ok)throw new Error();const value=await response.json() as Timer;if(request===sequence.current){accept(value);setError(undefined);}}catch{if(request===sequence.current)setError('Timer unavailable. Reload before recording time.');}},[accept]);
 useEffect(()=>{setTimer(undefined);void refresh();const interval=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);const visible=()=>{if(document.visibilityState==='visible')void refresh();};const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel(`stass:timer:${accountId}`):undefined;if(channel)channel.onmessage=()=>void refresh();window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);window.addEventListener('stass-time-recorded',visible);return()=>{clearInterval(interval);channel?.close();window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);window.removeEventListener('stass-time-recorded',visible);sequence.current++;};},[accountId,refresh]);
 useEffect(()=>{const interval=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(interval);},[]);
 async function change(action:'start'|'pause'|'reset'){
  if(!timer||mutating.current)return;mutating.current=true;setBusy(true);setError(undefined);++sequence.current;
  try{const response=await postJson('/api/workspace/timer',{action,revision:timer.revision});if(!response.ok){const message=(await messagesOf(response)).join(' ');mutating.current=false;await refresh();setError(message);return;}accept(await response.json() as Timer);if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(`stass:timer:${accountId}`);channel.postMessage('changed');channel.close();}}
  catch{setError('Could not update the timer. Reload it before trying again.');}
  finally{mutating.current=false;setBusy(false);}
 }
 const elapsed=Math.max(0,(timer?.elapsedMs??0)+(timer?.startedAt?now+offset.current-Date.parse(timer.startedAt):0)),seconds=Math.floor(elapsed/1000);
 const clock=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
 const minutes=Math.max(1,Math.ceil(elapsed/60000));
 const recordHref=timer?.timerId&&timer.revision?`/activities/new?minutes=${minutes}&timerId=${timer.timerId}&timerRevision=${timer.revision}`:'/activities/new';
 return <div className="workspace-timer"><button type="button" className="timer-control" disabled={!timer||busy||!!error} onClick={()=>void change(timer?.startedAt?'pause':'start')} aria-label={timer?.startedAt?'Pause timer':'Start timer'}><WorkspaceIcon name={timer?.startedAt?'pause':'play'}/><span className="timer-clock" role="timer" aria-live="off">{clock}</span></button><details className="timer-menu"><summary aria-label="Timer options"><WorkspaceIcon name="activities"/></summary><div className="workspace-create-menu"><p>{timer?.startedAt?'Timer running':'Timer paused'}</p><p className="timer-note">Saved across your tabs and devices. Choose a matter and review the minutes before recording.</p>{minutes>1440&&<p className="timer-note">This timer exceeds one work day. Record separate daily entries manually, then reset it.</p>}{error&&<p role="alert">{error}</p>}{seconds>0&&minutes<=1440&&!timer?.startedAt&&!error?<Link href={recordHref}>Record {minutes} minute{minutes===1?'':'s'}</Link>:<Link href="/activities/new">Record time manually</Link>}<button type="button" disabled={!timer||busy||!!error} onClick={()=>void change('reset')}>Reset timer</button><button type="button" disabled={busy} onClick={()=>void refresh()}>Reload timer</button></div></details></div>;
}
