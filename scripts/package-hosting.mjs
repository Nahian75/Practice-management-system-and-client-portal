import { cpSync, mkdirSync, mkdtempSync, readdirSync, statSync, lstatSync, readFileSync, chmodSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
mkdirSync(join(root,'logs'),{recursive:true});
const stage=mkdtempSync(join(root,'logs','hosting-release-'));
const paths=['.dockerignore','.gitignore','.gitattributes','.npmrc','Dockerfile','host.sh','compose.hosting.yaml','render.yaml','package.json','package-lock.json','dependency-age-exceptions.json','README.md','apps/api/package.json','apps/api/tsconfig.json','apps/api/tsconfig.build.json','apps/api/src','apps/api/migrations','apps/web/package.json','apps/web/tsconfig.json','apps/web/next.config.ts','apps/web/postcss.config.mjs','apps/web/src','apps/web/public','infra/hosting','infra/proxy','scripts/setup-hosting.mjs','scripts/package-hosting.mjs','scripts/check-dependency-age.mjs','scripts/check-production-hygiene.mjs','docs/clio-manage-design-and-features.md','docs/easy-hosting.md','docs/render-hosting.md','docs/deployment.md','docs/disaster-recovery.md','docs/security.md'];
paths.push('docs/security-operations.md','docs/reviews/2026-10-30-security-remediation.md','docs/reviews/2026-10-30-security-remediation-controls.csv','docs/reviews/2026-10-30-security-remediation-evidence.json','scripts/check-security-source.mjs','scripts/check-sarif.mjs');
function include(path){
 const name=basename(path);
 if(lstatSync(path).isSymbolicLink())throw new Error('Release packaging refuses source symlinks: '+name);
 return !name.startsWith('.env')&&!['node_modules','.next','dist','logs','uploads','storage','test-results','smoke','DEMO-LOGIN.txt','code.bat'].includes(name)&&!/(\.spec\.ts|\.test\.ts|\.tsbuildinfo|\.pem|\.key)$/.test(name);
}
for(const path of paths){const destination=join(stage,path);mkdirSync(resolve(destination,'..'),{recursive:true});cpSync(join(root,path),destination,{recursive:true,filter:include});}
chmodSync(join(stage,'host.sh'),0o755);
const files=[];
function walk(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isDirectory())walk(path);else files.push(path);}}
walk(stage);
if(files.some(path=>basename(path).startsWith('.env')||basename(path)==='DEMO-LOGIN.txt'))throw new Error('Private settings found in release.');
const output=join(root,'docs','stass-hosting-release.tar.gz');
const result=spawnSync('tar',['-czf',output,'-C',stage,'.'],{stdio:'inherit'});
if(result.status!==0)throw new Error('Could not create release archive.');
const digest=createHash('sha256').update(readFileSync(output)).digest('hex');
console.log(`Release: ${output}\nFiles: ${files.length}\nBytes: ${statSync(output).size}\nSHA256: ${digest}`);
