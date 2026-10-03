import { Body, Controller, Get, Module, Param, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../../../test/create-test-app.js';
import { ResponseSchema } from '../serialization/response-schema.decorator.js';

const createClientSchema = z.strictObject({
  name: z.string().min(1).max(200),
});

const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
});

let handlerCalls = 0;

@Controller('clients')
class ClientsFixtureController {
  @Post()
  @ResponseSchema(clientSchema)
  create(@Body({ schema: createClientSchema }) body: z.infer<typeof createClientSchema>) {
    handlerCalls += 1;
    return { id: 'new', ...body };
  }

  @Post('without-schema')
  @ResponseSchema(clientSchema)
  createWithoutSchema(@Body() body: unknown) {
    handlerCalls += 1;
    return { id: 'new', name: String(body) };
  }

  @Get(':id')
  @ResponseSchema(clientSchema)
  findOne(@Param('id', { schema: z.uuid() }) id: string) {
    handlerCalls += 1;
    return { id, name: 'Example Client' };
  }
}

@Module({ controllers: [ClientsFixtureController] })
class ClientsFixtureModule {}

describe('StrictSchemaValidationPipe', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(ClientsFixtureModule);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    handlerCalls = 0;
  });

  it('accepts a body that matches the schema', async () => {
    const response = await request(app.getHttpServer()).post('/clients').send({ name: 'Acme Ltd' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: 'new', name: 'Acme Ltd' });
  });

  it('rejects fields the schema does not declare', async () => {
    const response = await request(app.getHttpServer())
      .post('/clients')
      .send({ name: 'Acme Ltd', role: 'admin' });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body.message)).toContain('role');
    expect(handlerCalls).toBe(0);
  });

  it('rejects values of the wrong type', async () => {
    const response = await request(app.getHttpServer()).post('/clients').send({ name: 42 });

    expect(response.status).toBe(400);
    expect(handlerCalls).toBe(0);
  });

  it('rejects a missing required field', async () => {
    const response = await request(app.getHttpServer()).post('/clients').send({});

    expect(response.status).toBe(400);
  });

  it('cannot be used to pollute object prototypes', async () => {
    const response = await request(app.getHttpServer())
      .post('/clients')
      .set('Content-Type', 'application/json')
      .send('{"name":"Acme Ltd","__proto__":{"isAdmin":true}}');

    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
    expect(response.body).not.toHaveProperty('isAdmin');
  });

  it('validates route parameters', async () => {
    const valid = await request(app.getHttpServer()).get(
      '/clients/0b4e7d1c-3f0a-4d8e-9c55-2a1b6e9f7c10',
    );
    const invalid = await request(app.getHttpServer()).get('/clients/1%20OR%201=1');

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
  });

  it('refuses to run a handler whose body has no schema', async () => {
    const response = await request(app.getHttpServer())
      .post('/clients/without-schema')
      .send({ anything: true });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Internal Server Error');
    expect(handlerCalls).toBe(0);
  });
});
