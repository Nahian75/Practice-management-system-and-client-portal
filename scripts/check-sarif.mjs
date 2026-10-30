import{readdirSync,readFileSync}from'node:fs';
import{join}from'node:path';
const folder=process.argv[2];if(!folder)throw new Error('Provide the SARIF results directory');
let checked=0,blocked=0;
for(const file of readdirSync(folder).filter(name=>name.endsWith('.sarif'))){
 const report=JSON.parse(readFileSync(join(folder,file),'utf8'));
 for(const run of report.runs??[]){const rules=run.tool?.driver?.rules??[];
  for(const result of run.results??[]){checked++;const rule=rules.find(r=>r.id===result.ruleId);
   const severity=Number(rule?.properties?.['security-severity']??0);
   if(severity>=7||result.level==='error'){blocked++;console.error(`Blocked security result: ${result.ruleId}`);}
  }
 }
}
if(!readdirSync(folder).some(name=>name.endsWith('.sarif')))throw new Error('SAST produced no SARIF evidence');
console.log(`SAST: ${checked} results reviewed, ${blocked} blocking results.`);if(blocked)process.exitCode=1;
