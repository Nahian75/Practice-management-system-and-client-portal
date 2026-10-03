import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../src/app.setup.js';

export async function createTestApp(rootModule: Type<unknown>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [rootModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });

  configureApp(app);
  await app.init();

  return app;
}
