import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
let child;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{child?.kill(signal);process.exit(0);});
// Only the existing ephemeral-security cleanup is scheduled. AML/HR disposal remains explicit.
while(true) {
  const status=await new Promise(resolve=>{
    child=spawn(process.execPath,['dist/cli/retention-sweep.js'],{stdio:'inherit'});
    child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));
  });
  child=undefined;
  if(status!==0)console.error('Security retention sweep failed; retrying in one hour.');
  await setTimeout(status===0?24*60*60*1000:60*60*1000);
}
