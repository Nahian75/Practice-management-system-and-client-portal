import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { attachmentDisposition } from './content-disposition.js';
import { DocumentsService, type UploadRefusal } from './documents.service.js';
import { discardUpload, readUpload, UploadFormError } from './upload-request.js';

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

const uploadFieldsSchema = z.strictObject({ title: text(200), category: z.enum(CATEGORIES) });
const addedSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  category: z.enum(CATEGORIES),
  createdAt: z.iso.datetime(),
  version: z.object({
    number: z.number().int(),
    fileName: z.string(),
    mediaType: z.enum(MEDIA_TYPES),
    sizeBytes: z.number().int(),
    uploadedAt: z.iso.datetime(),
  }),
});

const versionSchema = z.object({
  number: z.number().int(),
  fileName: z.string(),
  mediaType: z.enum(MEDIA_TYPES),
  sizeBytes: z.number().int(),
  uploadedAt: z.iso.datetime(),
});
const listQuerySchema = z.strictObject({ before: z.uuid().optional() });
const listSchema = z.object({
  documents: z.array(
    z.object({ id: z.uuid(), title: z.string(), category: z.enum(CATEGORIES), createdAt: z.iso.datetime(), latest: versionSchema }),
  ),
  next: z.uuid().nullable(),
});
const detailsSchema = z.object({
  id: z.uuid(),
  matterId: z.uuid(),
  title: z.string(),
  category: z.enum(CATEGORIES),
  createdAt: z.iso.datetime(),
  versions: z.array(versionSchema.extend({ uploadedBy: z.object({ accountId: z.uuid(), displayName: z.string() }) })),
});

const DOCUMENT_NOT_FOUND_MESSAGE = 'No document with this id';

const REFUSALS: Readonly<Record<UploadRefusal, () => HttpException>> = {
  empty: () => new BadRequestException('The file is empty'),
  too_large: () => new HttpException('The file is over 50 MB', HttpStatus.PAYLOAD_TOO_LARGE),
  type: () =>
    new HttpException(
      'This kind of file is not accepted, or its content does not match its name. Accepted: PDF, Word, Excel, PowerPoint, text, email, JPEG, PNG',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    ),
  macros: () => new HttpException('Office files containing macros are not accepted', HttpStatus.UNSUPPORTED_MEDIA_TYPE),
  malware: () => new HttpException('The file contains malware and was not stored. Compliance has been told', HttpStatus.UNPROCESSABLE_ENTITY),
  scanner_unavailable: () => new ServiceUnavailableException('Files cannot be checked for malware at the moment, so uploads are paused. Try again later'),
  file_name: () => new BadRequestException('The file name is not accepted: up to 255 characters, with no control characters'),
  form: () => new BadRequestException('Send the title and category, then one file, and nothing else'),
  interrupted: () => new BadRequestException('The upload was interrupted'),
};

@Controller()
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  constructor(private readonly documents: DocumentsService) {}

  /**
   * A multipart form: `title` and `category`, then the file as `file`. The
   * file is checked, scanned and stored encrypted as it arrives.
   */
  @Post('matters/:matterId/documents')
  @RequirePermission('documents.add')
  @ResponseSchema(addedSchema)
  async add(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    // Refusals can come before the whole upload has arrived: the connection is then closed rather than read to its end.
    const refused = (error: HttpException) => {
      response.setHeader('Connection', 'close');
      return error;
    };

    let upload;
    try {
      upload = await readUpload(request, ['title', 'category']);
    } catch (error) {
      if (error instanceof UploadFormError) {
        throw refused(new BadRequestException(error.message));
      }
      throw error;
    }
    const details = uploadFieldsSchema.safeParse(upload.fields);
    if (!details.success) {
      discardUpload(upload.file);
      throw refused(new BadRequestException('Give a title (up to 200 characters) and a category, before the file'));
    }

    const result = await this.documents.add(matterId, details.data, upload, {
      actor: auditActorFor(session.account),
      accountId: session.account.id,
      context: requestContext(request),
    });
    switch (result.outcome) {
      case 'not_found':
        throw refused(new NotFoundException('No matter with this id'));
      case 'not_open':
        throw refused(new ConflictException('Documents are added only to open matters'));
      case 'refused':
        throw refused(REFUSALS[result.reason]());
      case 'added': {
        const { document } = result;
        return {
          ...document,
          createdAt: document.createdAt.toISOString(),
          version: { ...document.version, uploadedAt: document.version.uploadedAt.toISOString() },
        };
      }
    }
  }

  @Get('matters/:matterId/documents')
  @RequirePermission('documents.view')
  @ResponseSchema(listSchema)
  async list(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    const page = await this.documents.list(matterId, session.account.id, query.before);
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

  /** A document someone is not on the matter team of answers 404, like one that does not exist. */
  @Get('documents/:documentId')
  @RequirePermission('documents.view')
  @ResponseSchema(detailsSchema)
  async find(@Param('documentId', { schema: z.uuid() }) documentId: string, @CurrentSession() session: ResolvedSession) {
    const document = await this.documents.find(documentId, session.account.id);
    if (!document) {
      throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
    }
    return {
      ...document,
      createdAt: document.createdAt.toISOString(),
      versions: document.versions.map((version) => ({ ...version, uploadedAt: version.uploadedAt.toISOString() })),
    };
  }

  /**
   * The file, decrypted as it is sent, always as a download. If the stored
   * file fails its integrity check part-way, the connection is cut: the
   * browser sees an incomplete download, never altered content.
   */
  @Get('documents/:documentId/versions/:number/content')
  @RequirePermission('documents.view')
  @ResponseSchema(STREAMED)
  async download(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Param('number', { schema: z.coerce.number().int().min(1).max(1_000_000) }) number: number,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.documents.download(documentId, number, {
      actor: auditActorFor(session.account),
      accountId: session.account.id,
      context: requestContext(request),
    });
    if (result.outcome === 'not_found') {
      throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
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
      // pipeline has already cut the connection: with Content-Length set, the browser sees a failed download.
      this.logger.error(`Download of document ${documentId} version ${number} stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }
}
