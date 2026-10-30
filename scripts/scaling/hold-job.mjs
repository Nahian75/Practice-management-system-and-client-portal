// Child fixture: simulate a scheduler process dying while it owns a DB lock.
import 'reflect-metadata';
import {createDatabase} from '../../apps/api/dist/database/database.js';
import {ScheduledJobs} from '../../apps/api/dist/common/jobs/scheduled-jobs.js';
const url=new URL(process.env.SCALING_TEST_DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||!['/pms_test','/pms_e2e'].includes(url.pathname))throw new Error('Only isolated local databases allowed');
const db=createDatabase(url.href,2);
await new ScheduledJobs(db).runDue(process.env.SCALING_TEST_JOB_NAME,600,async()=>{
 process.send?.({locked:true});
 await new Promise(()=>{});
 return true;
});
