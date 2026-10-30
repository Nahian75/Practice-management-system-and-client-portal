import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import {hotp,timeStep} from '../apps/api/dist/auth/two-factor/totp.js';
const root=resolve(import.meta.dirname,'..'),base='http://127.0.0.1:3000',output=resolve(root,'docs/manage-ui-assets');
await mkdir(output,{recursive:true});
const section=(await readFile(resolve(root,'DEMO-LOGIN.txt'),'utf8')).split('PRIMARY TEST LOGIN')[1]?.split('SECOND REVIEWER LOGIN')[0];
const email=/Email: (.+)/.exec(section??'')?.[1]?.trim(),password=/Password: (.+)/.exec(section??'')?.[1]?.trim(),secret=/setup key" and type:\s+([A-Z2-7]+)/.exec(section??'')?.[1];
if(!email||!password||!secret)throw new Error('Local demo credentials are unavailable.');
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',bits=[...secret].map(c=>alphabet.indexOf(c).toString(2).padStart(5,'0')).join(''),key=Buffer.from((bits.match(/.{8}/g)??[]).map(b=>parseInt(b,2)));
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const findings=[];const assert=(value,message)=>{if(!value)throw new Error(message);console.log('PASS: '+message);};
const visualOnly=process.argv.includes('--visual-only');
try{
 const context=await browser.newContext({viewport:{width:1365,height:919},timezoneId:'UTC',reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(20000);
 await page.goto(base+'/sign-in');await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('Security code',{exact:true}).fill(hotp(key,timeStep(new Date())));await page.getByRole('button',{name:'Verify and sign in',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');
 assert(await page.getByRole('heading',{name:'Personal Dashboard',exact:true}).isVisible(),'Demo account signs in to the updated dashboard');
 if(!visualOnly){const date=new Date().toISOString().slice(0,10);await page.evaluate(async day=>{const response=await fetch(`/api/workspace/events?from=${day}&to=${day}`);if(!response.ok)return;for(const event of (await response.json()).events){if(event.title==='Local interface verification appointment')await fetch(`/api/workspace/events/${event.id}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}},date);}
 for(const [path,title] of [['/','dashboard'],['/calendar','calendar'],['/tasks','tasks'],['/matters','matters'],['/clients','contacts'],['/documents','documents'],['/activities','activities'],['/billing','billing'],['/accounts','accounts'],['/finance','finance'],['/reports','reports'],['/settings','settings'],['/help','help']]){
  const response=await page.goto(base+path);await page.locator('main h1').waitFor();await page.evaluate(()=>document.fonts.ready);
  assert(response.status()===200&&!(await page.locator('main').innerText()).includes('Application error'),title+' page loads');
  const text=await page.locator('body').innerText();assert(!text.includes(password)&&!text.includes(secret),title+' page exposes no login secret');
  await page.screenshot({path:resolve(output,title+'.png'),fullPage:true});
  if(title==='dashboard')await page.screenshot({path:resolve(output,'dashboard-reference-viewport.png')});
  if(['dashboard','calendar','tasks','contacts','billing','accounts','settings','help'].includes(title)){
   const accessibility=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();findings.push({page:title,violations:accessibility.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>n.target)}))});
  }
 }
 if(!visualOnly){
 await page.goto(base+'/');await page.keyboard.press('Control+k');assert(await page.getByLabel('Search your workspace',{exact:true}).evaluate(e=>e===document.activeElement),'Ctrl+K focuses global search');
 await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();assert(await page.locator('.manage-shell').evaluate(e=>getComputedStyle(e).gridTemplateColumns.startsWith('64px')),'Sidebar collapses');await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
 await page.getByRole('button',{name:'Start timer',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.timer-clock')?.textContent!=='00:00:00');await page.getByRole('button',{name:'Pause timer',exact:true}).click();await page.getByLabel('Timer options',{exact:true}).click();assert((await page.getByRole('link',{name:'Record 1 minute',exact:true}).getAttribute('href')).includes('minutes=1'),'Paused timer hands a rounded minute to time-entry form');await page.getByRole('button',{name:'Reset timer',exact:true}).click();
 await page.goto(base+'/settings/performance');const originalTarget=await page.getByLabel('Daily billable-hours target',{exact:true}).inputValue();await page.getByLabel('Daily billable-hours target',{exact:true}).fill('6');await page.getByRole('button',{name:'Save target',exact:true}).click();await page.getByRole('status').waitFor();await page.goto(base+'/');assert(await page.getByRole('img',{name:'0 recorded hours; 6 hour target',exact:true}).isVisible(),'Saved target appears in the hours ring');await page.goto(base+'/settings/performance');await page.getByLabel('Daily billable-hours target',{exact:true}).fill(originalTarget);await page.getByRole('button',{name:'Save target',exact:true}).click();await page.getByRole('status').waitFor();
 await page.goto(base+'/?view=firm');assert(await page.getByRole('heading',{name:'Firm Dashboard',exact:true}).isVisible(),'Firm dashboard tab loads');await page.goto(base+'/?view=feed');assert((await page.locator('main').innerText()).includes('latest 30 audit events'),'Authorised firm feed tab loads');
 await writeFile(resolve(output,'accessibility.json'),JSON.stringify(findings,null,2));
 await page.goto(base+'/calendar/new');await page.getByLabel('Event title',{exact:true}).fill('Local interface verification appointment');
 const start=new Date(Date.now()+3600000),end=new Date(start.getTime()+3600000);
 await page.getByLabel('Start (device time)',{exact:true}).fill(start.toISOString().slice(0,16));await page.getByLabel('End (device time)',{exact:true}).fill(end.toISOString().slice(0,16));
 const createdPromise=page.waitForResponse(r=>r.url().endsWith('/api/workspace/events')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save event',exact:true}).click();const created=await createdPromise;assert(created.status()===201,'Calendar form saves a real appointment');const {id}=await created.json();await page.waitForURL(url=>url.pathname==='/calendar',{timeout:15000});
 await page.goto(base+'/calendar?month='+start.toISOString().slice(0,7));const event=page.locator('#event-'+id);await event.waitFor();const cancellation=page.waitForResponse(r=>r.url().endsWith(`/api/workspace/events/${id}/cancel`));await event.getByRole('button',{name:'Cancel event',exact:true}).click();assert((await cancellation).status()===204,'Calendar cancellation request succeeds');await event.waitFor({state:'detached'});assert(true,'Calendar owner cancels the appointment through the interface');
 await page.goto(base+'/');await page.getByLabel('Search your workspace',{exact:true}).fill('review');await page.getByLabel('Search your workspace',{exact:true}).press('Enter');await page.waitForURL(url=>url.pathname==='/search');assert(await page.getByRole('heading',{name:'Search',exact:true}).isVisible(),'Global search opens its results view');
 }
 await page.setViewportSize({width:390,height:844});for(const path of ['/','/tasks','/calendar','/clients']){await page.goto(base+path);await page.locator('main h1').waitFor();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' fits the mobile viewport');await page.screenshot({path:resolve(output,(path==='/'?'dashboard':path.slice(1))+'-mobile.png'),fullPage:true});}
 await writeFile(resolve(output,'accessibility.json'),JSON.stringify(findings,null,2));assert(findings.every(f=>f.violations.length===0),'Representative screens pass automated WCAG A/AA checks');
 console.log('UI review captures: docs/manage-ui-assets');
}finally{await browser.close();}
