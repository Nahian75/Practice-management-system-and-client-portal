import {
  Controller,
  ForbiddenException,
  Get,
  InternalServerErrorException,
  Logger,
  Module,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../../../test/create-test-app.js';
import { ResponseSchema } from '../serialization/response-schema.decorator.js';

const SECRET_DETAIL = 'connection to db-prod-1 failed for user app_admin';
const emptySchema = z.object({});

@Controller('errors')
class ErrorsFixtureController {
  @Get('unexpected')
  @ResponseSchema(emptySchema)
  unexpected(): never {
    throw new Error(SECRET_DETAIL);
  }

  @Get('internal-http')
  @ResponseSchema(emptySchema)
  internalHttp(): never {
    throw new InternalServerErrorException(SECRET_DETAIL);
  }

  @Get('forbidden')
  @ResponseSchema(emptySchema)
  forbidden(): never {
    throw new ForbiddenException('You do not have access to this matter');
  }

  @Get('thrown-string')
  @ResponseSchema(emptySchema)
  thrownString(): never {
    throw SECRET_DETAIL;
  }
}

@Module({ controllers: [ErrorsFixtureController] })
class ErrorsFixtureModule {}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('AllExceptionsFilter', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(ErrorsFixtureModule);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['unexpected', 'internal-http', 'thrown-string'])(
    'hides the details of a server error (%s)',
    async (route) => {
      const response = await request(app.getHttpServer()).get(`/errors/${route}`);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal Server Error',
        reference: expect.stringMatching(UUID_PATTERN),
      });
      expect(JSON.stringify(response.body)).not.toContain('db-prod-1');
    },
  );

  it('logs the details under the same reference the client receives', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const response = await request(app.getHttpServer()).get('/errors/unexpected');

    expect(logError).toHaveBeenCalledOnce();
    const [message, stack] = logError.mock.calls[0] ?? [];
    expect(message).toBe(`${response.body.reference} GET /errors/unexpected`);
    expect(stack).toContain(SECRET_DETAIL);
  });

  it('never logs the query string, which may carry tokens', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await request(app.getHttpServer()).get('/errors/unexpected?resetToken=abc123');

    expect(JSON.stringify(logError.mock.calls)).not.toContain('abc123');
  });

  it('passes deliberate client errors through with their message', async () => {
    const response = await request(app.getHttpServer()).get('/errors/forbidden');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      message: 'You do not have access to this matter',
    });
  });

  it('answers unknown routes with 404', async () => {
    const response = await request(app.getHttpServer()).get('/no-such-route');

    expect(response.status).toBe(404);
    expect(response.body.statusCode).toBe(404);
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/errors/forbidden')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body.statusCode).toBe(400);
  });

  it('rejects oversized bodies with 413', async () => {
    const response = await request(app.getHttpServer())
      .post('/errors/forbidden')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'a'.repeat(200_000) }));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ statusCode: 413, message: 'Payload Too Large' });
  });
});
