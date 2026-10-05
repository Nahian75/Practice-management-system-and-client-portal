import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../test/create-test-app.js';
import { HealthModule } from './health/health.module.js';

describe('HTTP security headers', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(HealthModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not reveal the server technology', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the protective headers', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('applies the headers to error responses too', async () => {
    const response = await request(app.getHttpServer()).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('tells the browser not to keep any answer (review W2)', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not allow cross-origin browser requests', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://attacker.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('CSRF protection', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(HealthModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('blocks state-changing requests that a browser reports as cross-site', async () => {
    const response = await request(app.getHttpServer())
      .post('/health')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
  });

  it('falls back to the Origin header when Sec-Fetch-Site is absent', async () => {
    const response = await request(app.getHttpServer())
      .post('/health')
      .set('Origin', 'https://attacker.example');

    expect(response.status).toBe(403);
  });

  it('lets same-origin requests through to routing', async () => {
    const response = await request(app.getHttpServer())
      .post('/health')
      .set('Sec-Fetch-Site', 'same-origin');

    expect(response.status).toBe(404);
  });

  it('always allows safe methods', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(200);
  });
});
