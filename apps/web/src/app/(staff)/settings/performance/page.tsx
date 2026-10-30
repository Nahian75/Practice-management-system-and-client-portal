import Link from 'next/link';
import {apiGet} from '@/lib/api';
import {WorkspaceHeading} from '@/components/workspace-page';
import {NoAccess} from '@/components/no-access';
import type {PerformanceMetrics} from '@/lib/workspace';
import {PerformanceForm} from './performance-form';
export const metadata={title:'Performance settings'};
export default async function Page(){const result=await apiGet<PerformanceMetrics>('/workspace/performance');if(result.status===403)return <NoAccess what="personal performance settings"/>;return <><WorkspaceHeading title="Personal performance settings" description="Set the working-hours target shown on your dashboard."/>{result.body?<PerformanceForm minutes={result.body.dailyTargetMinutes}/>:<p role="alert">Your settings could not be loaded.</p>}<p><Link href="/">Back to dashboard</Link></p></>;}
