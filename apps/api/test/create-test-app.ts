import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { CLOCK, systemClock, type Clock } from '../src/common/time/clock.js';
import { ConfigModule } from '../src/config/config.module.js';
import { testEnv } from './database.js';

/**
 * A real app around the given module: same guard, pipes, interceptors and
 * filters as production, connected to the test database.
 */
export async function createTestApp(
  rootModule: Type<unknown>,
  options: { clock?: Clock } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(testEnv()), AuthModule, rootModule],
  })
    .overrideProvider(CLOCK)
    .useValue(options.clock ?? systemClock)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });

  configureApp(app);
  await app.init();

  return app;
}
