'use client';
import {useState} from 'react';
import {WorkspaceIcon} from './workspace-icon';
export function SidebarCollapse(){const[expanded,setExpanded]=useState(true);return <button className="sidebar-collapse" type="button" aria-expanded={expanded} aria-label={expanded?'Collapse sidebar':'Expand sidebar'} onClick={()=>setExpanded(!expanded)}><span aria-hidden="true"><WorkspaceIcon name="chevronLeft"/></span><span>{expanded?'Collapse':'Expand'}</span></button>;}
