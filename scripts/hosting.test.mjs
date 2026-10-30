import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';

const root=resolve(import.meta.dirname,'..');
const path=resolve(root,`.env.hosting.validation-${randomUUID()}`);
const args=['scripts/setup-hosting.mjs','--domain','portal.example.test','--admin-email','admin@example.test','--admin-name',"Alex O'Neil",'--mail-from','mail@example.test','--smtp-url','smtps://mailer:test%24pass%40%27@smtp.example.test:465','--output',path];
test('hosting setup creates consistent private settings and preserves existing keys',()=>{
  try {
    const first=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
    assert.equal(first.status,0,first.stderr);
    const original=readFileSync(path,'utf8'),env=parseEnv(original);
    const keys=Object.entries(env).filter(([name])=>name.endsWith('_ENCRYPTION_KEY')).map(([,value])=>value);
    assert.equal(keys.length,7);assert.equal(new Set(keys).size,7);
    for(const key of keys)assert.equal(Buffer.from(key,'base64').length,32);
    assert.equal(new URL(env.DATABASE_URL).password,env.PMS_APP_PASSWORD);
    assert.equal(new URL(env.MIGRATION_DATABASE_URL).password,env.PMS_OWNER_PASSWORD);
    assert.equal(new URL(env.DATABASE_URL).searchParams.get('sslmode'),'verify-full');
    assert.equal(decodeURIComponent(new URL(env.SMTP_URL).password),"test$pass@'");
    assert.equal(env.ADMIN_NAME,"Alex O'Neil");
    assert.equal(env.APP_BASE_URL,'https://portal.example.test');
    const second=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
    assert.equal(second.status,0);assert.equal(readFileSync(path,'utf8'),original);
    assert.ok(!first.stdout.includes(env.PMS_APP_PASSWORD));
  } finally {if(existsSync(path))rmSync(path);}
});
test('hosting setup rejects a URL in the domain field before writing settings',()=>{
  const invalid=args.map((arg,index)=>index===2?'https://portal.example.test/path':arg);
  const result=spawnSync(process.execPath,invalid,{cwd:root,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.equal(existsSync(path),false);
});
