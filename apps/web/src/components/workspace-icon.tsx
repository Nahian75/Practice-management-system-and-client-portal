const paths:Record<string,string>={
 eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 play:'m8 4 12 8-12 8V4Z',pause:'M8 4v16M16 4v16',chevronLeft:'m15 5-7 7 7 7',
 team:'M2 21v-2a4 4 0 0 1 4-4h5a4 4 0 0 1 4 4v2M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M16 4a4 4 0 0 1 0 8M19 15a4 4 0 0 1 3 4v2',
 briefcase:'M3 7h18v14H3V7ZM8 7V3h8v4M3 12a24 24 0 0 0 18 0M12 11v4',
 dashboard:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',calendar:'M4 5h16v16H4zM4 10h16M8 2v6M16 2v6M8 14h2M14 14h2M8 18h2',tasks:'M9 5h12M9 12h12M9 19h12M3 5l1 1 2-3M3 12l1 1 2-3M3 19l1 1 2-3',
 matters:'M3 7h7l2-3h9v16H3V7Z',contacts:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4',activities:'M12 8v5l3 2M21 13a9 9 0 1 1-3-7M16 2v5h5',billing:'M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6M9 12h6',
 accounts:'m3 9 9-6 9 6H3ZM5 12v6M10 12v6M15 12v6M20 12v6M3 21h18',documents:'M6 3h8l4 4v14H6V3ZM14 3v5h5M9 12h6M9 16h6',reports:'M4 3v18h17M8 17v-5M13 17V8M18 17V4',settings:'M4 7h9M17 7h3M4 17h3M11 17h9M17 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0M11 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
 search:'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',notifications:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',help:'M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Zm-4 10 3 3 5-6',plus:'M12 4v16M4 12h16',arrow:'m9 5 7 7-7 7',menu:'M3 6h18M3 12h18M3 18h18',
};
export function WorkspaceIcon({name,className=''}:{name:string;className?:string}){return <svg className={`workspace-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]||paths.matters}/></svg>;}
