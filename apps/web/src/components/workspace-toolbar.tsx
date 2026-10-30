import Link from 'next/link';
import { WorkspaceIcon } from './workspace-icon';
import {SignOutButton} from './sign-out-button';
import {LogoMark} from './logo-mark';
import {WorkspaceSearch} from './workspace-search';
import {WorkspaceTimer} from './workspace-timer';
export function WorkspaceToolbar({name,accountId,unread,canViewWork}:{name:string;accountId:string;unread:number;canViewWork:boolean}){
 return <div className="workspace-topbar" role="banner"><Link className="toolbar-brand" href="/" aria-label="Stass home"><LogoMark/></Link><WorkspaceSearch/><div className="workspace-top-actions">{canViewWork&&<><WorkspaceTimer accountId={accountId}/><details className="workspace-create"><summary>Create new<WorkspaceIcon name="plus"/></summary><div className="workspace-create-menu"><Link href="/clients/new">Contact</Link><Link href="/clients">Matter from a client</Link><Link href="/tasks/new">Task</Link><Link href="/calendar/new">Calendar event</Link><Link href="/documents/new">Document upload</Link><Link href="/activities/new">Time entry</Link></div></details></>}<Link className="workspace-icon-button" href="/notifications" aria-label={`Notifications, ${unread} unread`}><WorkspaceIcon name="notifications"/>{unread>0&&<span className="workspace-unread-dot"/>}</Link><Link className="workspace-avatar" href="/people/me" aria-label={`Your profile: ${name}`}>{name.split(/\s+/).map(part=>part[0]).slice(0,2).join('')}</Link></div><div className="workspace-mobile-account"><Link href="/settings">Account settings</Link><SignOutButton/></div></div>;
}
