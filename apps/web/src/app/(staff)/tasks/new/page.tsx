import {NewWorkPage} from '@/components/new-work-page';
export const metadata={title:'New task'};
export default function Page({searchParams}:{searchParams:Promise<{matter?:string}>}){return <NewWorkPage kind="tasks" searchParams={searchParams}/>;}
