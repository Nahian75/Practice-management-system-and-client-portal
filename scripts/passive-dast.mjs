// Linux CI: observe synthetic browser journeys; no active or external scan.
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root=resolve(import.meta.dirname,'..'),work=resolve(root,'logs/passive-dast');
if(process.platform!=='linux')throw new Error('Run passive DAST on Linux CI');
mkdirSync(work,{recursive:true});
const key=randomBytes(32).toString('hex'),name='stass-passive-'+randomBytes(6).toString('hex');
const image='ghcr.io/zaproxy/zaproxy@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238';
writeFileSync(resolve(work,'config.xml'),`<config><api><key>${key}</key></api></config>`,{mode:0o644});
const docker=args=>spawnSync('docker',args,{cwd:root,encoding:'utf8',maxBuffer:1024*1024,timeout:600000});
async function api(path){
 const response=await fetch('http://127.0.0.1:8090/JSON/'+path,{headers:{'X-ZAP-API-Key':key},signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('Passive scanner API unavailable');return response.json();
}
try{
 const start=docker(['run','--detach','--rm','--name',name,'--network','host','--volume',`${work}:/zap/wrk:rw`,image,
  'zap.sh','-daemon','-host','127.0.0.1','-port','8090','-configfile','/zap/wrk/config.xml']);
 if(start.status!==0)throw new Error('Could not start pinned scanner');
 let ready=false;
 for(let i=0;i<90;i++){try{await api('core/view/version/');ready=true;break;}catch{await delay(2000);}}
 if(!ready)throw new Error('Scanner startup timed out');
 const run=spawnSync(process.execPath,[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--workers=1'],{
  cwd:resolve(root,'apps/web'),env:{...process.env,PMS_DAST_PROXY:'http://127.0.0.1:8090'},
  encoding:'utf8',maxBuffer:50*1024*1024,timeout:1800000});
 writeFileSync(resolve(work,'browser.log'),(run.stdout??'')+(run.stderr??''),{mode:0o600});
 let drained=false;
 for(let i=0;i<90;i++){if(Number((await api('pscan/view/recordsToScan/')).recordsToScan)===0){drained=true;break;}await delay(2000);}
 if(!drained)throw new Error('Passive queue did not finish');
 const {alerts}=await api('core/view/alerts/?baseurl=http%3A%2F%2Flocalhost%3A3100&start=0&count=10000');
 const summary=new Map();
 for(const alert of alerts??[]){const id=String(alert.pluginId),entry=summary.get(id)??{rule:id,name:alert.alert,risk:alert.risk,instances:0};entry.instances++;summary.set(id,entry);}
 const evidence={scope:'synthetic local browser journeys; passive only',image,browserTestsPassed:run.status===0,
  alerts:[...summary.values()],externalPenetrationTestPerformed:false};
 writeFileSync(resolve(work,'summary.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 if(run.status!==0||[...summary.values()].some(alert=>alert.risk==='High'))process.exitCode=1;
}catch{console.error('Passive DAST did not pass; investigate private local logs.');process.exitCode=1;}
finally{docker(['stop',name]);writeFileSync(resolve(work,'config.xml'),'<config/>');}
