import {NewWorkPage} from '@/components/new-work-page';
export const metadata={title:'Upload document'};
export default function Page({searchParams}:{searchParams:Promise<{matter?:string}>}){return <NewWorkPage kind="documents" searchParams={searchParams}/>;}
