import test from 'node:test';
import assert from 'node:assert/strict';
import{generateKeyPairSync,randomUUID}from'node:crypto';
import{makeCheckpoint,verifyCheckpoint}from'../infra/hosting/audit-checkpoint.mjs';
const{privateKey,publicKey}=generateKeyPairSync('ed25519');
const signing=privateKey.export({type:'pkcs8',format:'pem'});
const event={id:randomUUID(),action:'document.viewed',metadata:{units:1}};
test('checkpoint authenticates deployment and rows, and detects modified/deleted history',()=>{
 const first=makeCheckpoint('test-firm',[event],[],signing);
 const previous=verifyCheckpoint(first,publicKey,'test-firm');
 assert.throws(()=>verifyCheckpoint(first,publicKey,'other-firm'));
 assert.throws(()=>verifyCheckpoint({...first,payload:{...first.payload,rows:[]}},publicKey,'test-firm'));
 assert.throws(()=>makeCheckpoint('test-firm',[],[],signing,previous),/deletion/);
 assert.throws(()=>makeCheckpoint('test-firm',[{...event,action:'other.action'}],[],signing,previous),/modification/);
 assert.equal(makeCheckpoint('test-firm',[event,{...event,id:randomUUID()}],[],signing,previous).payload.rows.length,2);
});
test('independent disposal evidence cannot silently disappear from later snapshots',()=>{
 const disposed={id:randomUUID(),kind:'hr_private_versions'};
 const first=makeCheckpoint('test-firm',[event],[disposed],signing);
 assert.throws(()=>makeCheckpoint('test-firm',[event],[],signing,verifyCheckpoint(first,publicKey,'test-firm')),/Disposal/);
});
