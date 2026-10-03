import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestApp } from '../../../test/create-test-app.js';
import { ResponseSchema } from './response-schema.decorator.js';
import { Public } from '../../auth/sessions/access.decorators.js';

const portalDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
});

const storedDocument = {
  id: 'doc-1',
  title: 'Completion statement',
  internalNote: 'Client may be difficult about fees',
  storageKey: 'matters/123/doc-1.pdf',
};

let handlerCalls = 0;

@Public()
@Controller('documents')
class DocumentsFixtureController {
  @Get('one')
  @ResponseSchema(portalDocumentSchema)
  one() {
    return storedDocument;
  }

  @Get('many')
  @ResponseSchema(portalDocumentSchema)
  many() {
    return [storedDocument, { ...storedDocument, id: 'doc-2' }];
  }

  @Get('wrong-shape')
  @ResponseSchema(portalDocumentSchema)
  wrongShape() {
    return { id: 'doc-1', secret: 'leaked-value' };
  }

  @Get('without-schema')
  withoutSchema() {
    handlerCalls += 1;
    return storedDocument;
  }
}

@Module({ controllers: [DocumentsFixtureController] })
class DocumentsFixtureModule {}

describe('StrictSchemaSerializerInterceptor', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(DocumentsFixtureModule);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    handlerCalls = 0;
  });

  it('removes fields the response schema does not declare', async () => {
    const response = await request(app.getHttpServer()).get('/documents/one');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'doc-1', title: 'Completion statement' });
  });

  it('filters every item in a list', async () => {
    const response = await request(app.getHttpServer()).get('/documents/many');

    expect(response.body).toEqual([
      { id: 'doc-1', title: 'Completion statement' },
      { id: 'doc-2', title: 'Completion statement' },
    ]);
  });

  it('fails without leaking data when the response does not match its schema', async () => {
    const response = await request(app.getHttpServer()).get('/documents/wrong-shape');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('leaked-value');
  });

  it('refuses to run a handler that has no response schema', async () => {
    const response = await request(app.getHttpServer()).get('/documents/without-schema');

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('internalNote');
    expect(handlerCalls).toBe(0);
  });
});
