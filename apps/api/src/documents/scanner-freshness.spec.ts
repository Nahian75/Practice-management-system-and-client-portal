import {describe,it,expect} from 'vitest';
import {validateScannerVersion,MAX_SIGNATURE_AGE_MS,ScannerUnavailableError} from './virus-scanner.js';
const now=Date.UTC(2026,9,30,12);
const reply=(timestamp:number)=>`ClamAV 1.5.4/30000/${new Date(timestamp).toUTCString().replace('GMT','').trim()}\0`;
describe('scanner definition freshness',()=>{
 it('accepts current definitions and the explicit age boundary',()=>{
   expect(()=>validateScannerVersion(reply(now-60_000),now)).not.toThrow();
   expect(()=>validateScannerVersion(reply(now-MAX_SIGNATURE_AGE_MS),now)).not.toThrow();
 });
 it.each(['stream: OK','ClamAV 1.5.4/30000/not-a-date',reply(now-MAX_SIGNATURE_AGE_MS-1000),reply(now+6*60_000)])('fails closed for unverifiable or stale status',value=>{
   expect(()=>validateScannerVersion(value,now)).toThrow(ScannerUnavailableError);
 });
});
