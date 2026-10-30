import Link from 'next/link';
import type {ReactNode} from 'react';
export function WorkspaceHeading({title,description,action,href}:{title:string;description:string;action?:string;href?:string}){return <header className="workspace-page-heading"><div><h1>{title}</h1><p>{description}</p></div>{action&&href&&<Link className="button" href={href}><span aria-hidden="true">+</span>{action}</Link>}</header>;}
export function WorkspaceEmpty({title,children,href,action}:{title:string;children:ReactNode;href?:string;action?:string}){return <div className="workspace-empty"><span className="workspace-empty-mark" aria-hidden="true">≡</span><h2>{title}</h2><p>{children}</p>{href&&action&&<Link className="button button-secondary" href={href}>{action}</Link>}</div>;}
