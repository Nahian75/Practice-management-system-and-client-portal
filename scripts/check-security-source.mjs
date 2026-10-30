import{readdirSync,readFileSync}from'node:fs';
import{join}from'node:path';
let failures=0;
function walk(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isDirectory())walk(file);else if(file.endsWith('.tsx')){const source=readFileSync(file,'utf8');if(/\bstyle=\{/.test(source)){console.error('Inline style violates the enforced CSP: '+file);failures++;}if(/dangerouslySetInnerHTML/.test(source)){console.error('Unsafe rendering requires an explicit reviewed exception: '+file);failures++;}}}}
walk('apps/web/src');
const proxy=readFileSync('apps/web/src/proxy.ts','utf8');
if(proxy.includes("'unsafe-inline'")){console.error('Blanket inline-style/script policy is forbidden');failures++;}
console.log(`Security source guard: ${failures} issue(s).`);if(failures)process.exitCode=1;
