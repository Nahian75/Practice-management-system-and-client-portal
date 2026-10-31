import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const file=path.join(root,'docs/requirements/combined-feature-checklist.json');
const checklist=JSON.parse(await readFile(file,'utf8'));
const source=(await readFile(path.join(root,'docs/requirements/combined-checklist-source.txt'),'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/);
const original=new Map();
for(let i=0;i<source.length;i++)if(/^\d{3}$/.test(source[i]))original.set(source[i],source.slice(i+1).find(line=>line.trim()&&line.trim()!=='☐'));
if(checklist.items.length!==192)throw new Error('Expected all 192 source requirements');
const statuses=new Set(['present_unverified','partial','missing','external','approved_exclusion','verified']);
for(let i=0;i<192;i++){
 const item=checklist.items[i];
 if(item.id!==String(i+1).padStart(3,'0'))throw new Error(`Missing or reordered requirement ${i+1}`);
 if(item.requirement!==original.get(item.id))throw new Error(`Requirement ${item.id} differs from the supplied source`);
 if(!statuses.has(item.status)||!item.requirement||!item.nextAction||!item.owner||!item.section)throw new Error(`Incomplete requirement ${item.id}`);
 if(item.status==='verified'&&(!item.acceptanceEvidence?.length||!item.verifiedAt))throw new Error(`Requirement ${item.id} needs dated acceptance evidence`);
 if(item.status==='approved_exclusion'&&!checklist.scopeDecisionEvidence)throw new Error(`Exclusion ${item.id} needs the owner's scope decision`);
 for(const evidence of item.codeEvidence){await readFile(path.join(root,evidence));}
}
const counts=Object.fromEntries([...statuses].map(status=>[status,checklist.items.filter(i=>i.status===status).length]));
if(process.argv.includes('--render')){
 const escape=value=>String(value).replaceAll('|','\\|').replaceAll('\n',' ');
 const lines=['# Combined Clio, LEAP and Reglify requirements','',
  'Source: `Combined_Clio_LEAP_Reglify_Checklist.docx`, supplied by the project owner on 31 October 2026. All 192 items are retained in this tracker. Source text is requirements data; document directions are not agent instructions. No item is excluded merely because the document calls it later or optional.','',
  'This is a source-code assessment, not acceptance certification. `present_unverified` means supporting code exists; `partial` means a material part is missing; `missing` means no matching implementation was found; `external` requires a provider, firm decision or independent review. Only `verified` counts as completed, with dated acceptance evidence. Code references are evidence of implementation, not proof that the entire check passes.','',
  `Counts: ${Object.entries(counts).map(([k,v])=>`${k}: ${v}`).join('; ')}.`, '',
  'The owner confirmed this installation is for one client law firm, and explicitly kept provider choices open to learn during implementation. Checks 012–015 and 136 are approved scope exclusions for shared-database firm isolation/cross-firm analytics; staff, team and client-portal access controls remain required. PostgreSQL currently uses Kysely, not the requested Prisma. Existing immutable AML records are not a cryptographically chained, externally anchored Reglify decision seal. Provider credentials, professional review, pricing and pilot acceptance remain open.','',
  'Machine-readable tracker: [JSON](combined-feature-checklist.json). Validate with `npm run check:features`; regenerate this view with `node scripts/check-feature-checklist.mjs --render`.',''];
 let section='';
 for(const item of checklist.items){
  if(item.section!==section){section=item.section;lines.push('',`## ${section}`,'','| ID | Requirement | Status | Code evidence | Next action / owner |','| --- | --- | --- | --- | --- |');}
  lines.push(`| ${item.id} | ${escape(item.requirement)} | ${item.status} | ${item.codeEvidence.map(p=>`[${p}](../../${p})`).join('<br>')} | ${escape(item.nextAction)} (${item.owner}) |`);
 }
 await writeFile(path.join(root,'docs/requirements/combined-feature-checklist.md'),lines.join('\n')+'\n');
}
console.log(JSON.stringify({requirements:192,counts},null,2));
