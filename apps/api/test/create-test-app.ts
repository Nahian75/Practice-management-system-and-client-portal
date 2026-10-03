import { randomInt } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { FETCH } from '../src/auth/passwords/breached-password-checker.js';
import { CLOCK, systemClock, type Clock } from '../src/common/time/clock.js';
import { ConfigModule } from '../src/config/config.module.js';
import type { Env } from '../src/config/env.js';
import { testEnv } from './database.js';

/**
 * A real app around the given module: same guard, pipes, interceptors and
 * filters as production, connected to the test database.
 */
/** Tests never reach the internet: the breached-password service answers "not listed". */
export const offlineFetch: typeof fetch = async () => new Response('');

export async function createTestApp(
  rootModule: Type<unknown>,
  options: { clock?: Clock; fetch?: typeof fetch; env?: Partial<Env> } = {},
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(testEnv(options.env)), AuthModule, rootModule],
  })
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? systemClock)
    .overrideProvider(FETCH)
    .useValue(options.fetch ?? offlineFetch)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  // Each request gets its own address unless the test sets one, so the per-address
  // sign-in limit only applies in tests that are about it.
  app.use((request: { headers: Record<string, unknown> }, _response: unknown, next: () => void) => {
    request.headers['x-forwarded-for'] ??= randomTestAddress();
    next();
  });
  configureApp(app);
  await app.init();

  return app;
}

/** An address from 198.18.0.0/15, which is reserved for testing. */
export function randomTestAddress(): string {
  return `198.${18 + randomInt(2)}.${randomInt(256)}.${randomInt(1, 255)}`;
}
