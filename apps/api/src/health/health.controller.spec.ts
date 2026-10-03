import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../test/create-test-app.js';
import { HealthModule } from './health.module.js';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(HealthModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports the service as up', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('exposes nothing beyond the status', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(Object.keys(response.body)).toEqual(['status']);
  });

  it('rejects methods other than GET', async () => {
    const response = await request(app.getHttpServer()).post('/health');

    expect(response.status).toBe(404);
  });
});
