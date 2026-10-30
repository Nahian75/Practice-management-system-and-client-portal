import { expect, test } from './support/test';
import { E2E_NO_API_WEB_URL } from '../playwright.config';
import { noAxeViolations } from './support/checks';
import { signedInStaff } from './support/session';
import {createServer} from 'node:http';

// These dependency-failure cases temporarily own the same loopback port.
test.describe.configure({mode:'serial'});

test('an address with no page says so, in plain words', async ({ page }) => {
  const response = await page.goto('/no-such-page');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page).toHaveTitle('Page not found – Stass');
  await noAxeViolations(page);
  await page.getByRole('link', { name: 'Go to the home page' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('a malformed client id gets the same page', async ({ page, request }) => {
  await signedInStaff(page, request);

  await page.goto('/clients/not-an-id');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('when the API is down, a page shows only a reference, never the error', async ({ page }) => {
  const response = await page.goto(`${E2E_NO_API_WEB_URL}/`);

  expect(response?.status()).toBe(500);
  await expect(page.getByRole('heading', { name: 'Sorry, there is a problem with the service' })).toBeVisible();
  await expect(page.getByText(/give this reference to whoever supports the system: \d+$/)).toBeVisible();
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const detail of ['fetch failed', 'econnrefused', '127.0.0.1', '3109', 'error:', ' at ']) {
    expect(text, detail).not.toContain(detail);
  }
  await noAxeViolations(page);
});

for(const status of [429,503]){
  test(`API ${status} shows a retry page rather than a false sign-out`,async({page})=>{
    const api=createServer((_request,response)=>{
      response.writeHead(status,{'content-type':'application/json'});
      response.end(JSON.stringify({message:'synthetic dependency failure'}));
    });
    await new Promise<void>(resolve=>api.listen(3109,'127.0.0.1',resolve));
    try{
      await page.goto(`${E2E_NO_API_WEB_URL}/`);
      await expect(page.getByRole('heading',{name:'Sorry, there is a problem with the service'})).toBeVisible();
      await expect(page.getByRole('heading',{name:'Sign in to your account'})).toHaveCount(0);
      await expect(page.getByText('synthetic dependency failure')).toHaveCount(0);
    }finally{await new Promise<void>((resolve,reject)=>api.close(error=>error?reject(error):resolve()));}
  });
}
