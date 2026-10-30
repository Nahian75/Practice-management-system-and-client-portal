import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const documentName = process.argv[2] ?? 'system-review-and-study-guide';
if (!/^[a-z0-9-]+$/.test(documentName)) throw new Error('Invalid document name');
const source = await readFile(resolve(root, `docs/${documentName}.md`), 'utf8');
const documentTitle = source.match(/^# (.+)/m)?.[1] ?? 'Stass learning guide';
const headingId = (s) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = (s) => escape(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `<a href="${/^(https?:|#)/.test(url) ? url : 'https://github.com/Nahian75/Practice-management-system-and-client-portal/blob/main/' + (url.startsWith('../') ? url.slice(3) : 'docs/' + url)}">${label}</a>`);

function diagram(code) {
  const nodes = new Map();
  const edges = [];
  for (const match of code.matchAll(/(\w+)\[\(?([^\]\n]+?)\)?\]/g)) nodes.set(match[1], match[2]);
  for (const line of code.split('\n')) {
    const match = line.trim().match(/^(\w+)(?:\[.*?\])?\s*-->\s*(\w+)/);
    if (match) edges.push([match[1], match[2]]);
  }
  return `<div class="diagram">${edges.map(([a,b]) => `<div class="connection"><span>${escape(nodes.get(a) ?? a)}</span><b>→</b><span>${escape(nodes.get(b) ?? b)}</span></div>`).join('')}</div>`;
}

const lines = source.split(/\r?\n/);
const blocks = [];
let list = null;
const closeList = () => { if (list) blocks.push(`</${list}>`); list = null; };
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) { closeList(); continue; }
  if (line.startsWith('```')) {
    closeList();
    const language = line.slice(3).trim();
    const code = [];
    while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
    blocks.push(language === 'mermaid' ? diagram(code.join('\n')) : `<pre><code>${escape(code.join('\n'))}</code></pre>`);
  } else if (line.startsWith('|')) {
    closeList();
    const rows = [];
    do {
      if (!/^\|[\s:|-]+\|$/.test(lines[i])) rows.push(lines[i].split('|').slice(1,-1).map(s => s.trim()));
      i++;
    } while (i < lines.length && lines[i].startsWith('|'));
    i--;
    blocks.push(`<table><thead><tr>${rows[0].map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  } else if (/^#{1,6} /.test(line)) {
    closeList();
    const [, hashes, title] = line.match(/^(#+) (.*)$/);
    blocks.push(`<h${hashes.length} id="${headingId(title)}">${inline(title)}</h${hashes.length}>`);
  } else if (/^(?:- |\d+\. )/.test(line)) {
    const type = line.startsWith('- ') ? 'ul' : 'ol';
    if (list !== type) { closeList(); blocks.push(`<${type}>`); list = type; }
    blocks.push(`<li>${inline(line.replace(/^(?:- |\d+\. )/, ''))}</li>`);
  } else {
    closeList();
    const para = [line];
    while (i + 1 < lines.length && lines[i+1].trim() && !/^(?:#|\||```|- |\d+\. )/.test(lines[i+1])) para.push(lines[++i]);
    blocks.push(`<p>${inline(para.join(' '))}</p>`);
  }
}
closeList();
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(documentTitle)}</title><style>
@page { size: A4; margin: 19mm 16mm 19mm; }
* { box-sizing: border-box; } body { margin: 0; font-family: Arial, sans-serif; font-size: 10pt; line-height: 1.48; color: #172033; }
h1 { font-size: 26pt; line-height: 1.15; color: #12233f; margin: 10mm 0 8mm; }
h2 { font-size: 17pt; color: #12233f; border-bottom: 2px solid #2563eb; padding-bottom: 5px; margin-top: 10mm; break-after: avoid; }
h3 { font-size: 12pt; color: #1d4ed8; margin-top: 6mm; break-after: avoid; }
p { margin: 0 0 3mm; } a { color: #1d4ed8; text-decoration: none; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; margin: 4mm 0 6mm; table-layout: fixed; font-size: 8.5pt; }
thead { display: table-header-group; } th { color: white; background: #12233f; text-align: left; } th,td { border: 1px solid #cbd5e1; padding: 6px 7px; vertical-align: top; overflow-wrap: anywhere; } tr { break-inside: avoid; } tbody tr:nth-child(even) { background: #f1f5f9; }
code { font-family: Consolas, monospace; font-size: .87em; overflow-wrap: anywhere; } pre { background: #eef2f7; border-left: 3px solid #2563eb; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; font-size: 9pt; }
li { margin-bottom: 2mm; } ul,ol { padding-left: 6mm; }
.diagram { background: #f5f7fb; border: 1px solid #cbd5e1; padding: 10px; margin: 4mm 0; break-inside: avoid; }
.connection { display: flex; align-items: center; gap: 10px; margin: 5px 0; font-size: 9pt; }
.connection span { background: white; border: 1px solid #94a3b8; border-radius: 4px; padding: 5px 9px; width: 45%; } .connection b { color: #2563eb; }
</style></head><body>${blocks.join('\n')}</body></html>`;
const htmlPath = resolve(root, `docs/${documentName}.html`);
const pdfPath = resolve(root, `docs/${documentName}.pdf`);
await writeFile(htmlPath, html);
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, displayHeaderFooter: true, outline: true, tagged: true,
    headerTemplate: '<div></div>', footerTemplate: '<div style="font-family:Arial;font-size:8px;width:100%;padding:0 16mm;color:#64748b;display:flex;justify-content:space-between"><span>STASS · SYSTEM DESIGN LEARNING SERIES · 30 OCTOBER 2026</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
  console.log(pdfPath);
} finally { await browser.close(); }
