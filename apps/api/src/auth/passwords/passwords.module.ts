import { Module } from '@nestjs/common';
import { BreachedPasswordChecker, FETCH } from './breached-password-checker.js';
import { PasswordHasher } from './password-hasher.js';
import { PasswordPolicy } from './password-policy.js';

@Module({
  providers: [{ provide: FETCH, useValue: fetch }, BreachedPasswordChecker, PasswordHasher, PasswordPolicy],
  exports: [PasswordHasher, PasswordPolicy],
})
export class PasswordsModule {}
