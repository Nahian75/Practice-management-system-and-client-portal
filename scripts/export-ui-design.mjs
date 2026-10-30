import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { hotp, timeStep } from '../apps/api/dist/auth/two-factor/totp.js';

const root = resolve(import.meta.dirname, '..');
const base = 'http://127.0.0.1:3000';
const output = resolve(root, 'docs/ui-design-assets');
await mkdir(output, { recursive: true });
// Local demo credentials stay in memory and never enter the exported document.
const login = (await readFile(resolve(root, 'DEMO-LOGIN.txt'), 'utf8')).split('PRIMARY TEST LOGIN')[1]?.split('SECOND REVIEWER LOGIN')[0];
if (!login) throw new Error('Prepare the local demo login first.');
const email = /Email: (.+)/.exec(login)?.[1]?.trim();
const password = /Password: (.+)/.exec(login)?.[1]?.trim();
const secret = /setup key" and type:\s+([A-Z2-7]+)/.exec(login)?.[1];
if (!email || !password || !secret) throw new Error('Local demo login is incomplete.');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const bits = [...secret].map(c => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
const key = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const screens = [];
const issues = [];
let tabs = [];
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  async function settled() {
    await page.locator('main').waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.locator('h1').first().waitFor();
  }
  async function capture(title, category = 'Staff workspace') {
    await settled();
    // Fail closed if any secret is visible as text or in a filled visible input.
    const exposed = await page.evaluate(values => {
      const text = document.body.innerText;
      return values.some(value => text.includes(value) || [...document.querySelectorAll('input')].some(input => input.type !== 'password' && input.value === value));
    }, [password, secret]);
    if (exposed) throw new Error('A secret would be visible in a screenshot; capture stopped.');
    const id = `${String(screens.length + 1).padStart(2, '0')}-${slug(title)}`;
    const path = resolve(output, `${id}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
    const metadata = await sharp(path).metadata();
    screens.push({ title, category, route: new URL(page.url()).pathname, file: `${id}.png`, width: metadata.width, height: metadata.height });
    console.log(`Captured: ${title} (${metadata.width} x ${metadata.height})`);
  }
  if (process.argv.includes('--reuse-captures')) {
    const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
    screens.push(...manifest.screens);
    issues.push(...manifest.issues);
    tabs = Array.from({ length: manifest.staffTabCount ?? 12 });
    if (process.argv.includes('--include-portal')) {
      const client = (await readFile(resolve(root, 'DEMO-LOGIN.txt'), 'utf8')).split('CLIENT PORTAL PREVIEW')[1];
      const clientEmail = /Email: (.+)/.exec(client)?.[1]?.trim();
      const clientPassword = /Password: (.+)/.exec(client)?.[1]?.trim();
      const clientCode = /Screenshot login backup code: (.+)/.exec(client)?.[1]?.trim();
      if (!clientEmail || !clientPassword || !clientCode) throw new Error('Client preview credentials unavailable.');
      await page.goto(`${base}/sign-in`);
      await page.getByLabel('Email address').fill(clientEmail);
      await page.getByLabel('Password', { exact: true }).fill(clientPassword);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel('Security code', { exact: true }).fill(clientCode);
      await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/portal');
      await capture('Client portal', 'Client workspace');
      await page.setViewportSize({ width: 390, height: 844 });
      await capture('Client portal on mobile', 'Client workspace');
      await context.request.post(`${base}/api/auth/sign-out`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
      const loginPath = resolve(root, 'DEMO-LOGIN.txt');
      const contents = await readFile(loginPath, 'utf8');
      await writeFile(loginPath, contents.replace(`Screenshot login backup code: ${clientCode}`, 'Screenshot login backup code: used during capture'));
    }
  } else {
  await page.goto(`${base}/sign-in`);
  await capture('Sign in', 'Account access');
  await page.goto(`${base}/forgot-password`);
  await capture('Forgot password', 'Account access');
  await page.goto(`${base}/sign-in`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Security code', { exact: true }).waitFor();
  await capture('Authenticator verification', 'Account access');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByLabel('Security code', { exact: true }).fill(hotp(key, timeStep(new Date())));
    await page.getByRole('button', { name: 'Verify and sign in', exact: true }).click();
    const outcome = await Promise.race([
      page.waitForURL(url => url.pathname === '/').then(() => 'signed-in'),
      page.getByRole('alert', { name: 'There is a problem' }).waitFor().then(() => 'retry'),
    ]);
    if (outcome === 'signed-in') break;
    if (attempt === 1) throw new Error('Demo sign-in failed.');
    const delay = 30_100 - (Date.now() % 30_000);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  await settled();
  tabs = await page.getByRole('navigation', { name: 'Main', exact: true }).locator('a').evaluateAll(links => links.map(link => ({ route: link.getAttribute('href'), label: link.querySelector('span')?.textContent?.trim() || link.textContent.trim() })));
  const extras = new Map();
  const capturedRoutes = new Set();
  const permittedExtra = /^\/(clients\/new|staff\/(invite|[0-9a-f-]{36})|hr\/(retention|exports)|compliance\/(retention|exports|ai)|matters\/(compliance-access|supervision-takeover))$/;
  for (const tab of tabs) {
    const response = await page.goto(base + tab.route);
    if (!response?.ok()) { issues.push(`${tab.label}: HTTP ${response?.status()}`); continue; }
    await capture(tab.label === 'Home' ? 'Personal Dashboard' : tab.label);
    capturedRoutes.add(tab.route);
    const links = await page.locator('main a[href]').evaluateAll(nodes => nodes.map(node => ({ route: node.getAttribute('href'), label: node.textContent.trim() })));
    for (const link of links) if (permittedExtra.test(link.route)) extras.set(link.route, link.label);
  }
  for (const [route, label] of extras) {
    if (capturedRoutes.has(route)) continue;
    const response = await page.goto(base + route);
    if (!response?.ok()) { issues.push(`${label}: HTTP ${response?.status()}`); continue; }
    const title = await page.locator('h1').first().innerText();
    await capture(title, 'Secondary screens');
    capturedRoutes.add(route);
  }
  for (const [route, title] of [['/finance', 'Finance tools'], ['/compliance', 'Compliance tools'], ['/hr', 'HR tools'], ['/policies', 'Policy tools']]) {
    await page.goto(base + route);
    const panels = page.locator('main details').filter({ hasNot: page.locator('.guide-summary') });
    if (!(await panels.count())) continue;
    await panels.evaluateAll(details => details.forEach(detail => { detail.open = true; }));
    await capture(title, 'Expanded feature forms');
  }
  await page.goto(`${base}/`);
  await page.locator('.page-guide summary').click();
  await capture('Page instructions', 'Learning and help');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/`);
  await capture('Dashboard on mobile', 'Responsive views');
  await page.goto(`${base}/clients`);
  await capture('Clients on mobile', 'Responsive views');
  await context.request.post(`${base}/api/auth/sign-out`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  await context.clearCookies();
  await page.goto(`${base}/sign-in`);
  await capture('Sign in on mobile', 'Responsive views');
  }

  const pages = [];
  for (const [screenIndex, screen] of screens.entries()) {
    const imagePath = resolve(output, screen.file);
    const maxTileHeight = screen.width < 600 ? 1440 : 1008;
    const count = Math.ceil(screen.height / maxTileHeight);
    const tileHeight = Math.ceil(screen.height / count);
    for (let part = 0; part < count; part++) {
      const top = part * tileHeight;
      const height = Math.min(tileHeight, screen.height - top);
      const image = await sharp(imagePath).extract({ left: 0, top, width: screen.width, height }).png().toBuffer();
      pages.push(`<section class="sheet"><header><div><span class="eyebrow">${escape(screen.category)} / ${String(screenIndex + 1).padStart(2, '0')}</span><h2>${escape(screen.title)}${count > 1 ? ` <small>· ${part + 1} of ${count}</small>` : ''}</h2></div><span class="route">${escape(screen.route)}</span></header><div class="image-frame"><img alt="${escape(screen.title)} screenshot, part ${part + 1}" src="data:image/png;base64,${image.toString('base64')}" /></div><footer><span>STASS / UI DESIGN REVIEW</span><span>${screen.width}px capture${part > 0 ? ' · continued below the previous image' : ''}</span></footer></section>`);
    }
  }
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'long' }).format(new Date());
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Stass UI Design Review</title><style>
  @page{size:A3 landscape;margin:12mm}*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;color:#0f172a;background:#f8fafc}.sheet{height:273mm;break-after:page;display:flex;flex-direction:column}.sheet:last-child{break-after:auto}header{display:flex;justify-content:space-between;align-items:center;min-height:17mm;margin-bottom:4mm;border-bottom:1px solid #cbd5e1;padding-bottom:3mm}h2{font-size:18pt;line-height:1.2;margin:2mm 0 0}small{font-size:11pt;color:#475569;font-weight:400}.eyebrow,.route,footer{font-size:8pt;color:#475569}.eyebrow{text-transform:uppercase;letter-spacing:.08em}.route{font-family:monospace}.image-frame{flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center}.image-frame img{display:block;max-width:100%;max-height:100%;object-fit:contain;object-position:top;border:1px solid #cbd5e1}footer{display:flex;justify-content:space-between;padding-top:3mm;min-height:8mm}.cover{padding:16mm;justify-content:space-between;background:#e2e8f0}.cover h1{font-size:48pt;line-height:1.05;letter-spacing:-.05em;max-width:210mm;margin:12mm 0}.cover p{font-size:13pt;line-height:1.6;max-width:245mm}.cover .meta{font-size:10pt;color:#475569}.contents{padding:8mm}.contents-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm 8mm;margin-top:6mm}.contents-item{border-bottom:1px solid #cbd5e1;padding:2mm 0;font-size:10pt;line-height:1.4}.contents-item span{font-size:8pt;display:block;color:#475569}.note{font-size:10pt;line-height:1.6;color:#475569;max-width:340mm;margin-top:8mm}
  </style></head><body><section class="sheet cover"><div><span class="eyebrow">STASS / PRACTICE MANAGEMENT & CLIENT PORTAL</span><h1>The interface,<br />screen by screen.</h1><p>A visual record of the current local application: account access, every available staff navigation tab, secondary screens, expanded forms and mobile layouts.</p><p class="meta">${escape(date)} · ${screens.length} captured screens · ${tabs.length} staff tabs<br />Desktop: 1440 × 900 · Mobile: 390 × 844</p></div><p class="note">Captured using a local demonstration account. Empty and unconfigured states are shown as they appear. Record-specific matter, document and financial detail pages require sample records and are not represented where none exist. Client-portal desktop and mobile empty states are included when a local client preview account is available. Passwords, setup keys and backup codes are excluded.</p></section><section class="sheet contents"><span class="eyebrow">SCREEN INDEX</span><h2>What is inside</h2><div class="contents-grid">${screens.map((screen,i)=>`<div class="contents-item">${String(i+1).padStart(2,'0')} · ${escape(screen.title)}<span>${escape(screen.category)}</span></div>`).join('')}</div>${issues.length ? `<p class="note">Unavailable screens: ${escape(issues.join('; '))}</p>` : ''}<p class="note">Long screens continue over several pages to keep text readable. Individual full-page PNG captures are supplied beside this PDF in the ui-design-assets folder.</p></section>${pages.join('')}</body></html>`;
  await writeFile(resolve(root, 'docs/stass-ui-design-review.html'), html);
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ date, screens, issues, staffTabCount: tabs.length, screenshotPages: pages.length }, null, 2));
  const printPage = await browser.newPage();
  await printPage.setContent(html, { waitUntil: 'load' });
  await printPage.pdf({ path: resolve(root, 'docs/stass-ui-design-review.pdf'), format: 'A3', landscape: true, printBackground: true, preferCSSPageSize: true, tagged: true, outline: true });
  console.log(`PDF complete: ${screens.length} screens, ${pages.length + 2} document pages.`);
  if (issues.length) console.log('Capture limitations: ' + issues.join('; '));
} finally { await browser.close(); }
