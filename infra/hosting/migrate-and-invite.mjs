import { spawnSync } from 'node:child_process';
import pg from 'pg';
function run(args) { const result=spawnSync(process.execPath,args,{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1); }
run(['--enable-source-maps','dist/database/migrate.js']);
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
let needsInvitation;
try {await db.connect();const result=await db.query("SELECT EXISTS(SELECT 1 FROM app.accounts WHERE kind='staff') AS ready");needsInvitation=!result.rows[0].ready;} finally {await db.end();}
if(needsInvitation) {
  if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_NAME)throw new Error('First administrator details are missing.');
  run(['dist/cli/invite.js','--kind','staff','--email',process.env.ADMIN_EMAIL,'--name',process.env.ADMIN_NAME,'--role','administrator','--role','partner','--role','compliance']);
} else console.log('Existing staff accounts preserved; no bootstrap invitation was sent.');
