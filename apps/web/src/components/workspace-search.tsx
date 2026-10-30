'use client';
import {useEffect,useRef} from 'react';
import {WorkspaceIcon} from './workspace-icon';
export function WorkspaceSearch(){
 const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{const shortcut=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.current?.focus();}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[]);
 return <form className="workspace-global-search" role="search" action="/search"><WorkspaceIcon name="search"/><label className="visually-hidden" htmlFor="workspace-search">Search your workspace</label><input ref={input} id="workspace-search" name="q" type="search" placeholder="Search your practice" minLength={2} maxLength={100} required autoComplete="off" aria-keyshortcuts="Control+K Meta+K"/><kbd aria-hidden="true">Ctrl + K</kbd><button className="visually-hidden" type="submit">Search</button></form>;
}
