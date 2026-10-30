import { existsSync, mkdirSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root='/certs';
const authority='/authority';
const openssl=args=>execFileSync('openssl',args,{stdio:['ignore','ignore','pipe']});
mkdirSync(root,{recursive:true,mode:0o755});
mkdirSync(authority,{recursive:true,mode:0o700});
if(!existsSync(`${root}/ca.crt`)) {
  openssl(['req','-x509','-newkey','rsa:3072','-sha256','-nodes','-days','3650','-subj','/CN=Stass Private Services CA','-keyout',`${authority}/ca.key`,'-out',`${root}/ca.crt`]);
  chmodSync(`${authority}/ca.key`,0o600);chmodSync(`${root}/ca.crt`,0o644);
}
const extra=(process.env.TLS_EXTRA_NAMES??'').split(',').filter(Boolean);
if(extra.some(name=>!/^[a-z][a-z0-9-]{0,40}$/.test(name)))throw new Error('Invalid private-service certificate name.');
for(const name of ['postgres','storage',...extra]) {
  const folder=`${root}/${name}`;mkdirSync(folder,{recursive:true,mode:0o755});
  if(existsSync(`${folder}/server.crt`)) {
    try {openssl(['x509','-checkend','2592000','-noout','-in',`${folder}/server.crt`]);continue;} catch { /* Renew using the same private CA. */ }
  }
  writeFileSync(`${folder}/extensions.cnf`,`subjectAltName=DNS:${name}\nextendedKeyUsage=serverAuth\n`);
  openssl(['req','-new','-newkey','rsa:3072','-nodes','-subj',`/CN=${name}`,'-keyout',`${folder}/server.key`,'-out',`${folder}/server.csr`]);
  openssl(['x509','-req','-sha256','-days','825','-in',`${folder}/server.csr`,'-CA',`${root}/ca.crt`,'-CAkey',`${authority}/ca.key`,'-CAcreateserial','-extfile',`${folder}/extensions.cnf`,'-out',`${folder}/server.crt`]);
  chmodSync(`${folder}/server.key`,0o600);chmodSync(`${folder}/server.crt`,0o644);
  if(name==='postgres')chownSync(`${folder}/server.key`,70,70);
}
console.log('Private-service TLS certificates are ready. Existing CA and data were preserved.');
