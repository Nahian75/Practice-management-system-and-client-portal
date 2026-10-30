import https from 'node:https';
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { hotp, timeStep } from '../apps/api/dist/auth/two-factor/totp.js';
const root=resolve(import.meta.dirname,'..');
const cloud=process.argv.includes('--cloud');
const env=parseEnv(readFileSync(resolve(root,cloud?'.env.hosting.cloud-smoke':'.env.hosting.smoke'),'utf8'));
if(env.DOMAIN!=='localhost'||env.PUBLIC_BIND!=='127.0.0.1'||env.HTTPS_PORT!=='18443')throw new Error('This verifier runs only against the isolated localhost smoke installation.');
const ca=readFileSync(resolve(root,cloud?'logs/cloud-hosting-edge-ca.crt':'logs/hosting-edge-ca.crt'));
const email=env.ADMIN_EMAIL,credentialFile=resolve(root,cloud?'logs/cloud-hosting-smoke-login.json':'logs/hosting-smoke-login.json');
function request(path,{method='GET',body,headers={},cookie=''}={}) {
 return new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body);
  const req=https.request({hostname:'localhost',family:4,port:18443,path,method,ca,headers:{Origin:'https://localhost:18443',...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...(cookie?{Cookie:cookie}:{}),...headers}},res=>{const buffers=[];res.on('data',c=>buffers.push(c));res.on('end',()=>{const text=Buffer.concat(buffers).toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data,cookie:(res.headers['set-cookie']??[]).map(c=>c.split(';')[0]).join('; ')});});});
  req.setTimeout(15000,()=>req.destroy(new Error('HTTPS check timed out.')));req.on('error',reject);if(payload)req.write(payload);req.end();
 });
}
function expect(condition,message){if(!condition)throw new Error(message);console.log('PASS: '+message);}
async function mailTokens(path){const result=await(await fetch('http://127.0.0.1:18025/api/v1/search?query='+encodeURIComponent(`to:"${email}"`))).json();const found=[];for(const m of result.messages??[]){const detail=await(await fetch(`http://127.0.0.1:18025/api/v1/message/${m.ID}`)).json();const token=new RegExp(path+'#token=([A-Za-z0-9_-]{43})').exec(detail.Text??'')?.[1];if(token)found.push(token);}return found;}
async function tokenFromMail(path,ignored=[]){const until=Date.now()+20000;while(Date.now()<until){const token=(await mailTokens(path)).find(value=>!ignored.includes(value));if(token)return token;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Expected smoke-test email did not arrive.');}
const page=await request('/sign-in');expect(page.status===200&&page.text.includes('sign-in-screen'),'Standalone Next.js sign-in loads through verified HTTPS');
expect(String(page.headers['content-security-policy']).includes("frame-ancestors 'none'"),'Frontend security headers survive the reverse proxy');
const asset=/["'](\/_next\/static\/[^"']+\.css(?:\?[^"']*)?)["']/.exec(page.text)?.[1];expect(Boolean(asset),'Frontend stylesheet URL is present');expect((await request(asset.replaceAll('&amp;','&'))).status===200,'Standalone image serves frontend styles');
expect((await request('/api/health')).status===200,'Direct API routing works');
expect((await request('/api/auth/sign-in',{method:'POST',body:{email,password:'not-the-password'},headers:{Origin:'https://other.example'}})).status===403,'Cross-site authentication requests are refused');
expect((await request('/api/auth/sign-in',{method:'POST',body:{email,password:'x'.repeat(1100000)}})).status===413,'Public request body limit is enforced');
let credentials=existsSync(credentialFile)?JSON.parse(readFileSync(credentialFile,'utf8')):null;
const save=()=>writeFileSync(credentialFile,JSON.stringify(credentials),{mode:0o600});
if(!credentials){
 const token=await tokenFromMail('/accept-invitation');expect(Boolean(token),'Bootstrap administrator invitation is delivered over TLS SMTP');
 const password=randomBytes(24).toString('base64url');
 const setup=await request('/api/auth/invitations/password',{method:'POST',body:{token,password}});expect(setup.status===200&&Boolean(setup.data?.twoFactor),'Account password and authenticator setup succeed');
 const secret=setup.data.twoFactor.secret,alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
 const bits=[...secret].map(c=>alphabet.indexOf(c).toString(2).padStart(5,'0')).join('');
 const key=Buffer.from((bits.match(/.{8}/g)??[]).map(b=>parseInt(b,2)));
 const complete=await request('/api/auth/invitations/complete',{method:'POST',body:{token,code:hotp(key,timeStep(new Date()))}});expect(complete.status===200&&complete.data.backupCodes.length===10,'Invitation activation and recovery-code generation succeed');
 credentials={email,password,backupCodes:complete.data.backupCodes};save();
}
if(credentials.email!==email)throw new Error('Smoke credentials do not match this installation.');
async function signIn(){const password=await request('/api/auth/sign-in',{method:'POST',body:{email,password:credentials.password}});expect(password.status===200,'Password step succeeds through HTTPS');const code=credentials.backupCodes.at(-1);if(!code)throw new Error('No unused smoke backup code.');const second=await request('/api/auth/two-factor',{method:'POST',body:{code},cookie:password.cookie});expect(second.status===200,'Second-factor step succeeds through HTTPS');credentials.backupCodes.pop();save();expect((second.headers['set-cookie']??[]).some(value=>value.startsWith('__Host-session=')&&/; Secure/i.test(value)&&/; HttpOnly/i.test(value)),'Session cookie keeps its Secure and HttpOnly attributes');return second.cookie;}
let session=await signIn();
expect((await request('/',{cookie:session})).text.includes('Personal Dashboard'),'Authenticated server-rendered dashboard reaches the private API');
const boundary='stass-hosting-upload-check';
const upload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHosting routing check\r\n--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nother\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="routing-check.txt"\r\nContent-Type: text/plain\r\n\r\n`),Buffer.alloc(6*1024*1024,65),Buffer.from(`\r\n--${boundary}--\r\n`)]);
const routed=await request('/api/matters/00000000-0000-4000-8000-000000000001/documents',{method:'POST',body:upload,cookie:session,headers:{'Content-Type':`multipart/form-data; boundary=${boundary}`}});
expect(routed.status===404&&routed.data?.message==='No matter with this id','6 MB multipart upload reaches API authorization without a frontend payload limit; no document is stored');
const oldResetTokens=await mailTokens('/reset-password');
await request('/api/auth/password-reset/request',{method:'POST',body:{email}});
const resetToken=await tokenFromMail('/reset-password',oldResetTokens);expect(Boolean(resetToken),'Password reset email is delivered through configured TLS SMTP');
const nextPassword=randomBytes(24).toString('base64url');
const changed=await request('/api/auth/password-reset/complete',{method:'POST',body:{token:resetToken,password:nextPassword}});expect(changed.status===204,'Emailed password-reset link works');credentials.password=nextPassword;save();
session=await signIn();
const ended=await request('/api/auth/sign-out',{method:'POST',body:{},cookie:session});expect(ended.status===204,'Sign-out succeeds');
console.log('Hosting smoke verification complete. Credentials stayed in the ignored logs directory.');
