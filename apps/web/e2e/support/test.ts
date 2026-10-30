import {randomInt} from 'node:crypto';
import {test as base} from '@playwright/test';

// Every journey represents a different origin behind the test-only trusted
// loopback proxy. Rate-limit assertions belong in explicit abuse-limit tests.
export const testAddress=()=>`198.${18+randomInt(2)}.${randomInt(256)}.${randomInt(1,255)}`;
export const test=base.extend({
  extraHTTPHeaders:async({extraHTTPHeaders},use)=>{
    await use({...extraHTTPHeaders,'X-Forwarded-For':testAddress()});
  },
});
export {expect} from '@playwright/test';
export type {Page,APIRequestContext} from '@playwright/test';
