import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv(process.env);
  const app = await NestFactory.create(AppModule.forRoot(env), { logger: createLogger(env) });

  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.PORT, env.HOST);
}

await bootstrap();
