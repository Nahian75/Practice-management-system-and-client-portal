'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {WorkspaceIcon} from './workspace-icon';
type Timer={elapsed:number;startedAt:number|null};
const empty:Timer={elapsed:0,startedAt:null};
export function WorkspaceTimer({accountId}:{accountId:string}){
 const[timer,setTimer]=useState<Timer>(empty),[now,setNow]=useState(0),[ready,setReady]=useState(false);
 const storageKey=`stass:timer:${accountId}`;
 function persist(value:Timer){setTimer(value);try{sessionStorage.setItem(storageKey,JSON.stringify(value));}catch{/* The timer can still be used for this page when storage is disabled. */}}
 useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved&&Number.isFinite(saved.elapsed)&&saved.elapsed>=0&&(saved.startedAt===null||(Number.isFinite(saved.startedAt)&&saved.startedAt<=Date.now())))setTimer(saved);}catch{}setNow(Date.now());setReady(true);},[storageKey]);
 useEffect(()=>{if(timer.startedAt===null)return;const id=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(id);},[timer.startedAt]);
 useEffect(()=>{const recorded=()=>{setTimer(empty);try{sessionStorage.removeItem(storageKey);}catch{}};window.addEventListener('stass-time-recorded',recorded);return()=>window.removeEventListener('stass-time-recorded',recorded);},[storageKey]);
 const elapsed=Math.max(0,timer.elapsed+(timer.startedAt===null?0:now-timer.startedAt)),seconds=Math.floor(elapsed/1000);
 const clock=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');
 const minutes=Math.min(1440,Math.max(1,Math.ceil(elapsed/60000)));
 function toggle(){const time=Date.now();setNow(time);persist(timer.startedAt===null?{...timer,startedAt:time}:{elapsed:timer.elapsed+time-timer.startedAt,startedAt:null});}
 return <div className="workspace-timer"><button type="button" className="timer-control" disabled={!ready} onClick={toggle} aria-label={timer.startedAt===null?'Start timer':'Pause timer'}><WorkspaceIcon name={timer.startedAt===null?'play':'pause'}/><span className="timer-clock" role="timer" aria-live="off">{clock}</span></button><details className="timer-menu"><summary aria-label="Timer options"><WorkspaceIcon name="activities"/></summary><div className="workspace-create-menu"><p>{timer.startedAt===null?'Timer paused':'Timer running'}</p><p className="timer-note">Time is saved as a billable entry after you choose a matter and confirm it.</p>{seconds>0&&timer.startedAt===null?<Link href={`/activities/new?minutes=${minutes}`}>Record {minutes} minute{minutes===1?'':'s'}</Link>:<Link href="/activities/new">Record time manually</Link>}<button type="button" onClick={()=>persist(empty)}>Reset timer</button></div></details></div>;
}
