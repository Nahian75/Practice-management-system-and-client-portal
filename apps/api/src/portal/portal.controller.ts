import { pipeline } from 'node:stream/promises';
import { Controller, Get, HttpStatus, Logger, NotFoundException, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ClientOnly } from '../auth/sessions/access.decorators.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { attachmentDisposition } from '../documents/content-disposition.js';
import { PortalService, type PortalActor } from './portal.service.js';

const MATTER_TYPES = [
  'residential_property',
  'commercial_property',
  'family',
  'litigation',
  'employment',
  'wills_probate',
  'corporate',
  'immigration',
  'crime',
  'other',
] as const;
const CATEGORIES = ['correspondence', 'contract', 'evidence', 'identity', 'court', 'other'] as const;
const MEDIA_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'image/jpeg',
  'image/png',
  'message/rfc822',
] as const;

const teamMemberSchema = z.object({ displayName: z.string(), role: z.enum(['supervising_partner', 'fee_earner']) });
const matterSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  title: z.string(),
  matterType: z.enum(MATTER_TYPES),
  status: z.enum(['open', 'closed']),
  openedAt: z.iso.datetime(),
  team: z.array(teamMemberSchema),
});
const pageQuerySchema = z.strictObject({ before: z.uuid().optional() });
const matterListSchema = z.object({ matters: z.array(matterSchema), next: z.uuid().nullable() });
const documentListSchema = z.object({
  documents: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      category: z.enum(CATEGORIES),
      createdAt: z.iso.datetime(),
      latest: z.object({
        fileName: z.string(),
        mediaType: z.enum(MEDIA_TYPES),
        sizeBytes: z.number().int(),
        uploadedAt: z.iso.datetime(),
      }),
    }),
  ),
  next: z.uuid().nullable(),
});

function actorFor(session: ResolvedSession, request: Request): PortalActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

@ClientOnly()
@Controller('portal')
export class PortalController {
  private readonly logger = new Logger(PortalController.name);

  constructor(private readonly portal: PortalService) {}

  @Get('matters')
  @ResponseSchema(matterListSchema)
  async matters(@Query({ schema: pageQuerySchema }) query: z.infer<typeof pageQuerySchema>, @CurrentSession() session: ResolvedSession) {
    const page = await this.portal.clientMatters(session.account.id, query.before);
    return {
      matters: page.matters.map((matter) => ({ ...matter, openedAt: matter.openedAt.toISOString() })),
      next: page.next,
    };
  }

  @Get('matters/:matterId')
  @ResponseSchema(matterSchema)
  async matter(@Param('matterId', { schema: z.uuid() }) matterId: string, @CurrentSession() session: ResolvedSession) {
    const matter = await this.portal.clientMatter(matterId, session.account.id);
    if (!matter) {
      throw new NotFoundException('No matter with this id');
    }
    return { ...matter, openedAt: matter.openedAt.toISOString() };
  }

  @Get('matters/:matterId/documents')
  @ResponseSchema(documentListSchema)
  async documents(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Query({ schema: pageQuerySchema }) query: z.infer<typeof pageQuerySchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    const page = await this.portal.clientDocuments(matterId, session.account.id, query.before);
    if (!page) {
      throw new NotFoundException('No matter with this id');
    }
    return {
      documents: page.documents.map((document) => ({
        ...document,
        createdAt: document.createdAt.toISOString(),
        latest: { ...document.latest, uploadedAt: document.latest.uploadedAt.toISOString() },
      })),
      next: page.next,
    };
  }

  @Get('documents/:documentId/content')
  @ResponseSchema(STREAMED)
  async download(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.portal.clientDownload(documentId, actorFor(session, request));
    if (result.outcome === 'not_found') {
      throw new NotFoundException('No document with this id');
    }
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', result.mediaType);
    response.setHeader('Content-Length', String(result.sizeBytes));
    response.setHeader('Content-Disposition', attachmentDisposition(result.fileName));
    // Should a browser ever show it anyway: no script, no requests, its own origin.
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    try {
      await pipeline(result.file, response);
    } catch (error) {
      // Content-Length makes an interrupted or altered file a failed download, rather than a shorter file.
      this.logger.error(`Client download of document ${documentId} stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }
}
