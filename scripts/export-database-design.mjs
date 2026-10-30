import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'docs/database-design.md'), 'utf8');
const schema = JSON.parse(await readFile(resolve(root, 'docs/database-schema.json'), 'utf8'));
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const inline = value => escape(value).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_,label,url)=>`<span>${label}</span>`);
const diagrams = [];
function diagram(code) {
  const rows = [];
  if (code.startsWith('erDiagram')) {
    for (const line of code.split('\n')) {
      const match = line.match(/^\s+(\w+)\s+([|o{}-]+)\s+(\w+)\s+:\s+(\w+)/);
      if (!match) continue;
      const [,parent,relation,child,column] = match;
      const parentCount = relation.startsWith('||') ? 'one' : 'zero or one';
      const childCount = relation.endsWith('o{') ? 'zero or many' : 'zero or one';
      rows.push({from:parent,to:child,label:column,note:`${parentCount} to ${childCount}`});
    }
  } else {
    const names=new Map([...code.matchAll(/(\w+)\[([^\]]+)\]/g)].map(m=>[m[1],m[2].replace(/^\(|\)$/g,'')]));
    for (const line of code.split('\n')) {
      const match=line.trim().match(/^(\w+)(?:\[.*?\])?\s*-->\s*(\w+)/);
      if(match) rows.push({from:names.get(match[1])??match[1],to:names.get(match[2])??match[2],label:'connects to',note:''});
    }
  }
  if (!rows.length) throw new Error('A diagram could not be rendered.');
  const items=rows.map((row,i)=>{
    const y=i*52+4;
    return `<g><rect x="0" y="${y}" width="222" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="12" y="${y+24}" font-size="11" fill="#0f172a">${escape(row.from)}</text><path d="M222 ${y+20}H434" stroke="#64748b" stroke-width="1.2"/><path d="m428 ${y+16} 6 4-6 4" stroke="#64748b" fill="none"/><rect x="232" y="${y+1}" width="192" height="16" fill="#f8fafc"/><text x="328" y="${y+12}" text-anchor="middle" font-size="9" fill="#334155">${escape(row.label)}</text><text x="328" y="${y+36}" text-anchor="middle" font-size="8" fill="#475569">${escape(row.note)}</text><rect x="434" y="${y}" width="222" height="40" rx="6" fill="#e2e8f0" stroke="#94a3b8"/><text x="446" y="${y+24}" font-size="11" fill="#0f172a">${escape(row.to)}</text></g>`;
  }).join('');
  diagrams.push(rows.length);
  return `<figure class="relationship-map"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Database relationship map" viewBox="0 0 656 ${rows.length*52+8}" style="width:100%;font-family:Arial,sans-serif">${items}</svg><figcaption>Selected relationships. Each row reads from the parent on the left to the referencing record on the right.</figcaption></figure>`;
}

const lines=source.split(/\r?\n/),blocks=[];
let list;
const closeList=()=>{if(list)blocks.push(`</${list}>`);list=undefined;};
for(let i=0;i<lines.length;i++) {
  const line=lines[i];
  if(!line.trim()){closeList();continue;}
  if(line.startsWith('# '))continue;
  if(line.startsWith('```')) {
    closeList();const language=line.slice(3).trim(),code=[];
    while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);
    blocks.push(language==='mermaid'?diagram(code.join('\n')):`<pre>${escape(code.join('\n'))}</pre>`);
  } else if(line.startsWith('|')) {
    closeList();const rows=[];
    do{if(!/^\|[\s:|-]+\|$/.test(lines[i]))rows.push(lines[i].split('|').slice(1,-1).map(s=>s.trim()));i++;}while(i<lines.length&&lines[i].startsWith('|'));i--;
    blocks.push(`<table><thead><tr>${rows[0].map(cell=>`<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(row=>`<tr>${row.map(cell=>`<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  } else if(/^#{2,6} /.test(line)) {
    closeList();const [,hashes,title]=line.match(/^(#+) (.*)$/);blocks.push(`<h${hashes.length}>${inline(title)}</h${hashes.length}>`);
  } else if(/^(?:- |\d+\. )/.test(line)) {
    const kind=line.startsWith('- ')?'ul':'ol';if(list!==kind){closeList();blocks.push(`<${kind}>`);list=kind;}blocks.push(`<li>${inline(line.replace(/^(?:- |\d+\. )/,''))}</li>`);
  } else {
    closeList();const paragraph=[line];while(i+1<lines.length&&lines[i+1].trim()&&!/^(?:#|\||```|- |\d+\. )/.test(lines[i+1]))paragraph.push(lines[++i]);blocks.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
}
closeList();
const inventory=schema.tables.map(table=>`<tr><td><code>${escape(table.name)}</code></td><td>${escape(table.domain)}</td><td>${table.columns.length}</td><td>${table.constraints.filter(c=>c.kind==='f').length}</td></tr>`).join('');
const date=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',dateStyle:'long'}).format(new Date());
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stass Database Design</title><style>
@page{size:A4;margin:18mm 16mm 20mm}*{box-sizing:border-box}body{margin:0;color:#0f172a;background:#f8fafc;font:10pt/1.5 Arial,sans-serif}h1{font-size:40pt;line-height:1.1;letter-spacing:-.04em;margin:14mm 0 8mm}h2{font-size:17pt;line-height:1.3;margin:9mm 0 4mm;padding-bottom:3mm;border-bottom:1px solid #94a3b8;break-after:avoid}h3{font-size:12pt;break-after:avoid}p{margin:0 0 3mm}ul,ol{padding-left:6mm}li{margin-bottom:2mm}code{font:8pt/1.5 Consolas,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e2e8f0;padding:4mm}table{border-collapse:collapse;width:100%;table-layout:fixed;margin:4mm 0 6mm;font-size:8pt}th,td{padding:2.5mm;border:1px solid #cbd5e1;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#e2e8f0;color:#334155}thead{display:table-header-group}tr{break-inside:avoid}strong{font-weight:700}.cover{height:252mm;display:flex;flex-direction:column;justify-content:space-between;break-after:page;padding:12mm 0}.eyebrow{font-size:9pt;letter-spacing:.12em;color:#475569}.cover p{font-size:12pt;line-height:1.7}.stats{display:grid;grid-template-columns:1fr 1fr;gap:4mm;margin-top:8mm}.stats div{border:1px solid #cbd5e1;border-radius:3mm;padding:5mm;background:#e2e8f0;font-size:10pt}.stats strong{display:block;font-size:24pt}.small{font-size:9pt!important;color:#475569}.relationship-map{break-inside:avoid;margin:5mm 0;padding:3mm;background:#f8fafc;border:1px solid #cbd5e1;border-radius:2mm}.relationship-map svg{display:block}figcaption{font-size:8pt;color:#475569;margin-top:3mm}.appendix{break-before:page}.inventory td:first-child{width:40%}
</style></head><body><section class="cover"><div><span class="eyebrow">STASS / TECHNICAL DESIGN</span><h1>Database<br />design.</h1><p>Entities, relationships, integrity rules and an implementation roadmap for the practice management system and client portal.</p><div class="stats"><div><strong>${schema.summary.tables}</strong>Application tables</div><div><strong>${schema.summary.foreignKeys}</strong>Foreign-key relationships</div><div><strong>${schema.summary.columns}</strong>Column definitions</div><div><strong>${schema.summary.migrations}</strong>Applied migrations</div></div></div><div><p class="small">${escape(date)} · PostgreSQL catalog baseline</p><p class="small">Includes relationship maps and the complete application-table inventory. This report contains schema metadata, not client records, passwords or encryption keys.</p></div></section>${blocks.join('\n')}<section class="appendix"><h2>Appendix: complete table inventory</h2><p class="small">The companion database-schema.json and database-design.html contain complete column definitions, constraints, indexes and triggers for every table below.</p><table class="inventory"><thead><tr><th>Table</th><th>Database area</th><th>Columns</th><th>Foreign keys</th></tr></thead><tbody>${inventory}</tbody></table></section></body></html>`;
const htmlPath=resolve(root,'docs/database-design-report.html'),pdfPath=resolve(root,'docs/database-design.pdf');
await writeFile(htmlPath,html);
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try {
 const page=await browser.newPage();await page.setContent(html,{waitUntil:'load'});
 await page.pdf({path:pdfPath,format:'A4',printBackground:true,preferCSSPageSize:true,tagged:true,outline:true,displayHeaderFooter:true,headerTemplate:'<div></div>',footerTemplate:'<div style="font-family:Arial;font-size:8px;color:#475569;width:100%;padding:0 16mm;display:flex;justify-content:space-between"><span>STASS / DATABASE DESIGN</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'});
 console.log(`Exported ${pdfPath}; ${diagrams.length} relationship maps and ${schema.tables.length} inventory entries.`);
} finally {await browser.close();}
