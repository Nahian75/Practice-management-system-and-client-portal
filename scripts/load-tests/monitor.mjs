// Opt-in telemetry for the isolated loopback load-test processes only.
import {appendFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
if(process.env.PMS_LOAD_TEST!=='1'||process.env.HOST!=='127.0.0.1')throw new Error('Load telemetry requires an isolated test process');
const root=resolve(import.meta.dirname,'../..'),file=resolve(process.env.PMS_LOAD_METRICS??'');
if(!file.startsWith(resolve(root,'logs/load-tests')+sep))throw new Error('Invalid telemetry destination');
const delay=monitorEventLoopDelay({resolution:20});delay.enable();
let cpu=process.cpuUsage(),last=performance.now(),elu=performance.eventLoopUtilization();
setInterval(()=>{
 const now=performance.now(),usage=process.cpuUsage(cpu),current=process.cpuUsage(),loop=performance.eventLoopUtilization(elu);
 appendFileSync(file,JSON.stringify({at:Date.now(),cpuPercentOneCore:100*(usage.user+usage.system)/((now-last)*1000),rssMiB:process.memoryUsage().rss/1048576,
  eventLoopUtilization:loop.utilization,eventLoopP95Ms:delay.percentile(95)/1e6})+'\n');
 cpu=current;last=now;elu=performance.eventLoopUtilization();delay.reset();
},1000).unref();
