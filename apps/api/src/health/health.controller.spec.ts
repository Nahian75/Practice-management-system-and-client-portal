import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {ReadinessService} from './readiness.service.js';
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

  it('reports unavailable readiness without exposing dependency details',async()=>{
    const spy=vi.spyOn(app.get(ReadinessService),'ready').mockResolvedValueOnce(false);
    try {
      const response=await request(app.getHttpServer()).get('/ready');
      expect(response.status).toBe(503);expect(response.body).toEqual({status:'unavailable'});
      expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);
    } finally {spy.mockRestore();}
  });

  it('exposes nothing beyond the status', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(Object.keys(response.body)).toEqual(['status']);
  });

  it('rejects methods other than GET', async () => {
    const response = await request(app.getHttpServer()).post('/health');

    expect(response.status).toBe(404);
  });

  it('withdraws readiness while draining without marking liveness down',async()=>{
    app.get(ReadinessService).beforeApplicationShutdown();
    expect((await request(app.getHttpServer()).get('/ready')).status).toBe(503);
    expect((await request(app.getHttpServer()).get('/health')).status).toBe(200);
  });
});
