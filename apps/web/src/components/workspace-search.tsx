'use client';
import Link from 'next/link';
import {workspacePages,type WorkspacePageAccess} from '@/lib/workspace-pages';
import {useEffect,useRef,useState} from 'react';
import {WorkspaceIcon} from './workspace-icon';
interface Suggestion {href:string;label:string;detail:string}
interface Records {matters:{id:string;reference:string;title:string}[];clients:{id:string;reference:string;name:string}[]}
export function WorkspaceSearch({canViewStaff=false,canViewWork=false,pageAccess={}}:{canViewStaff?:boolean;canViewWork?:boolean;pageAccess?:WorkspacePageAccess}){
 const input=useRef<HTMLInputElement>(null);
 const [query,setQuery]=useState('');
 const [open,setOpen]=useState(false);
 const [results,setResults]=useState<{query:string;items:Suggestion[];message:string}>();
 const term=query.trim();
 const pages=workspacePages(canViewStaff,canViewWork,pageAccess);
 const matches=term.length>=2?pages.filter(p=>`${p.label} ${p.detail}`.toLowerCase().includes(term.toLowerCase())):[];
 const records=results?.query===term?results.items:[];
 useEffect(()=>{const shortcut=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.current?.focus();}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[]);
 useEffect(()=>{
  if(!open||term.length<2||!canViewWork)return;
  const controller=new AbortController();
  const timer=window.setTimeout(async()=>{
   setResults({query:term,items:[],message:'Searching records…'});
   try{
    const response=await fetch(`/api/workspace/search?${new URLSearchParams({q:term})}`,{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error('Search unavailable');
    const data:Records=await response.json();
    if(controller.signal.aborted)return;
    const items=[...data.matters.slice(0,4).map(m=>({href:`/matters/${m.id}`,label:m.title,detail:`Matter · ${m.reference}`})),...data.clients.slice(0,4).map(c=>({href:`/clients/${c.id}`,label:c.name,detail:`Contact · ${c.reference}`}))];
    setResults({query:term,items,message:items.length?'':'No matching matters or contacts.'});
   }catch{if(!controller.signal.aborted)setResults({query:term,items:[],message:'Record suggestions are unavailable. Open a matching page or submit a search.'});}
  },300);
  return()=>{window.clearTimeout(timer);controller.abort();};
 },[term,open,canViewWork]);
 function suggestions(items:Suggestion[]){return <ul>{items.map(item=><li key={item.href}><Link href={item.href} onClick={()=>setOpen(false)}>{item.label}<span>{item.detail}</span></Link></li>)}</ul>;}
 return <form className="workspace-global-search" role="search" action="/search"
  onSubmit={()=>setOpen(false)} onFocus={()=>setOpen(true)}
  onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false);}}
  onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();input.current?.focus();setOpen(false);}}}>
  <WorkspaceIcon name="search"/><label className="visually-hidden" htmlFor="workspace-search">Search your workspace</label>
  <input ref={input} id="workspace-search" name="q" type="search" placeholder="Search your practice" minLength={2} maxLength={100} required autoComplete="off" aria-keyshortcuts="Control+K Meta+K" aria-describedby="workspace-search-hint" value={query} onChange={event=>{setQuery(event.target.value);setOpen(true);}}/>
  <span id="workspace-search-hint" className="visually-hidden">Type at least two characters for suggestions. Tab to a suggestion, or press Enter to search all records.</span>
  <kbd aria-hidden="true">Ctrl + K</kbd><button className="visually-hidden" type="submit">Search</button>
  {open&&term.length>=2&&<section className="workspace-search-suggestions" aria-label="Search suggestions">
   {!!matches.length&&<><h2>Pages</h2>{suggestions(matches)}</>}
   {!!records.length&&<><h2>Records</h2>{suggestions(records)}</>}
   <p role="status">{canViewWork?(results?.query===term?results.message:'Searching records…'):(!matches.length?'No matching pages.':'')}</p>
   <Link className="workspace-search-all" href={`/search?q=${encodeURIComponent(term)}`} onClick={()=>setOpen(false)}>See all results for “{term}”</Link>
  </section>}
 </form>;
}
