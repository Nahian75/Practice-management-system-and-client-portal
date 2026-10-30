import type {Env} from '../../config/env.js';
import {SecretBox} from './secret-box.js';
export const KEY_PURPOSES=['TOTP','MAIL','FINANCE','AML','SUSPICION','HR','DOCUMENT'] as const;
export type KeyPurpose=typeof KEY_PURPOSES[number];
export function keyParameters(env:Partial<Env>,purpose:KeyPurpose):[Buffer,number,ReadonlyMap<number,Buffer>] {
 const value=env[`${purpose}_ENCRYPTION_KEY`];
 if(!value)throw new Error('Missing encryption key configuration');
 return [Buffer.from(value,'base64'),env.ENCRYPTION_KEY_VERSION??1,
  new Map(Object.entries(env.PREVIOUS_ENCRYPTION_KEYS?.[purpose]??{}).map(([version,key])=>[Number(version),Buffer.from(key,'base64')]))];
}
export const secretBoxFor=(env:Partial<Env>,purpose:KeyPurpose)=>new SecretBox(...keyParameters(env,purpose));
