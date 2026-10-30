import {NewWorkPage} from '@/components/new-work-page';
export const metadata={title:'Record time'};
export default function Page({searchParams}:{searchParams:Promise<{matter?:string}>}){return <NewWorkPage kind="activities" searchParams={searchParams}/>;}
