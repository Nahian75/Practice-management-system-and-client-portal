'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WorkspaceIcon } from './workspace-icon';

export function NavLinks({unreadCount,canViewFinance,canViewCompliance,complianceAttention,canViewHr,canViewWork=true,canViewStaff=false}:
{unreadCount:number;canViewFinance:boolean;canViewCompliance:boolean;complianceAttention:number;canViewHr:boolean;canViewWork?:boolean;canViewStaff?:boolean}){
 const pathname=usePathname();
 const groups=[
  {label:'Practice',items:[{href:'/',label:'Dashboard',icon:'dashboard'},...(canViewWork?[{href:'/calendar',label:'Calendar',icon:'calendar'},{href:'/tasks',label:'Tasks',icon:'tasks'},{href:'/matters',label:'Matters',icon:'matters'},{href:'/clients',label:'Contacts',icon:'contacts'},{href:'/activities',label:'Activities',icon:'activities'},{href:'/documents',label:'Documents',icon:'documents'}]:[])]},
  {label:'Business',items:[...(canViewFinance?[{href:'/billing',label:'Billing',icon:'billing'},{href:'/accounts',label:'Accounts',icon:'accounts'}]:[]),{href:'/reports',label:'Reports',icon:'reports'},...(canViewCompliance?[{href:'/compliance',label:'Compliance',icon:'shield',count:complianceAttention}]:[]),{href:'/people',label:'Team directory',icon:'team'},...(canViewHr?[{href:'/hr',label:'HR workspace',icon:'briefcase'}]:[])]},
  {label:'Workspace',items:[...(canViewStaff?[{href:'/staff',label:'Staff management',icon:'team'}]:[]),{href:'/notifications',label:'Notifications',icon:'notifications',count:unreadCount},{href:'/policies',label:'Policies & guidance',icon:'documents'},{href:'/report-concern',label:'Report a concern',icon:'shield'},{href:'/settings',label:'Settings',icon:'settings'},{href:'/help',label:'Help & guides',icon:'help'}]},
 ];
 return <nav aria-label="Main" className="nav workspace-navigation">{groups.map(group=><div className="workspace-nav-group" key={group.label}><p className="workspace-nav-label">{group.label}</p><ul>{group.items.map(item=>{const current=item.href==='/'?pathname==='/':pathname.startsWith(item.href);const count='count'in item?item.count:0;return <li key={item.href}><Link href={item.href} aria-label={item.label} aria-current={current?'page':undefined}><WorkspaceIcon name={item.icon}/><span>{item.label}</span>{!!count&&<span className="nav-badge">{count}</span>}</Link></li>;})}</ul></div>)}</nav>;
}
