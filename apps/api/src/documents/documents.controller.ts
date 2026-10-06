import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
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
import { NO_CONTENT, ResponseSchema, STREAMED } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import { attachmentDisposition } from './content-disposition.js';
import {
  DocumentsService,
  UPLOAD_BYTES_PER_HOUR,
  UPLOAD_WINDOW_SECONDS,
  UPLOADS_PER_HOUR,
  type DocumentActor,
  type UploadRefusal,
} from './documents.service.js';
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
  sharedWithClient: z.boolean(),
  versions: z.array(versionSchema.extend({ uploadedBy: z.object({ accountId: z.uuid(), displayName: z.string() }) })),
  withdrawal: z
    .object({ withdrawnBy: z.object({ accountId: z.uuid(), displayName: z.string() }), reason: z.string(), withdrawnAt: z.iso.datetime() })
    .nullable(),
});

const withdrawalSchema = z.strictObject({ reason: text(500, 10) });

const DOCUMENT_NOT_FOUND_MESSAGE = 'No document with this id';
const WITHDRAWN_MESSAGE = 'This document was withdrawn';

const REFUSALS: Readonly<Record<UploadRefusal, () => HttpException>> = {
  empty: () => new BadRequestException('The file is empty'),
  too_large: () => new HttpException('The file is over 50 MB', HttpStatus.PAYLOAD_TOO_LARGE),
  type: () =>
    new HttpException(
      'This kind of file is not accepted, or its content does not match its name. Accepted: PDF, Word, Excel, PowerPoint, text, email, JPEG, PNG',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    ),
  macros: () => new HttpException('Office files containing macros are not accepted', HttpStatus.UNSUPPORTED_MEDIA_TYPE),
  active_content: () =>
    new HttpException(
      'Office files that fetch content from elsewhere when opened, or carry embedded objects or controls, are not accepted. Save a copy without them, or as PDF',
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    ),
  unscannable: () =>
    new HttpException(
      'The file could not be fully checked for viruses: it is too large or too complex once unpacked, so it was not stored. Save it as PDF, or split it',
      HttpStatus.UNPROCESSABLE_ENTITY,
    ),
  malware: () => new HttpException('The file contains malware and was not stored. Compliance has been told', HttpStatus.UNPROCESSABLE_ENTITY),
  scanner_unavailable: () => new ServiceUnavailableException('Files cannot be checked for malware at the moment, so uploads are paused. Try again later'),
  file_name: () => new BadRequestException('The file name is not accepted: up to 255 characters, with no control characters'),
  form: () => new BadRequestException('Send the title and category, then one file, and nothing else'),
  interrupted: () => new BadRequestException('The upload was interrupted'),
  over_allowance: () =>
    new HttpException(
      `You have added the most documents allowed in an hour (${UPLOADS_PER_HOUR} files or ${UPLOAD_BYTES_PER_HOUR / 1024 ** 3} GB). Try again later`,
      HttpStatus.TOO_MANY_REQUESTS,
    ),
};

function actorFor(session: ResolvedSession, request: Request): DocumentActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

/**
 * Refusals can come before the whole upload has arrived: the connection is
 * then closed rather than read to its end.
 */
function closing(response: Response) {
  return (error: HttpException) => {
    response.setHeader('Connection', 'close');
    return error;
  };
}

async function readForm(request: Request, fieldNames: readonly string[], refused: (error: HttpException) => HttpException) {
  try {
    return await readUpload(request, fieldNames);
  } catch (error) {
    if (error instanceof UploadFormError) {
      throw refused(new BadRequestException(error.message));
    }
    throw error;
  }
}

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
    const refused = closing(response);
    const upload = await readForm(request, ['title', 'category'], refused);
    const details = uploadFieldsSchema.safeParse(upload.fields);
    if (!details.success) {
      discardUpload(upload.file);
      throw refused(new BadRequestException('Give a title (up to 200 characters) and a category, before the file'));
    }

    const result = await this.documents.add(matterId, details.data, upload, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw refused(new NotFoundException('No matter with this id'));
      case 'not_open':
        throw refused(new ConflictException('Documents are added only to open matters'));
      case 'refused':
        if (result.reason === 'over_allowance') {
          response.setHeader('Retry-After', String(UPLOAD_WINDOW_SECONDS));
        }
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

  /** A multipart form with only the file, as `file`. Checked exactly as a first upload. */
  @Post('documents/:documentId/versions')
  @RequirePermission('documents.add')
  @ResponseSchema(versionSchema)
  async addVersion(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refused = closing(response);
    const upload = await readForm(request, [], refused);
    const result = await this.documents.addVersion(documentId, upload, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw refused(new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE));
      case 'not_open':
        throw refused(new ConflictException('Documents are added only to open matters'));
      case 'withdrawn':
        throw refused(new ConflictException(WITHDRAWN_MESSAGE));
      case 'refused':
        if (result.reason === 'over_allowance') {
          response.setHeader('Retry-After', String(UPLOAD_WINDOW_SECONDS));
        }
        throw refused(REFUSALS[result.reason]());
      case 'added':
        return { ...result.version, uploadedAt: result.version.uploadedAt.toISOString() };
    }
  }

  /** By whoever added the document, or the matter's supervising partner. Final. */
  @Post('documents/:documentId/withdrawal')
  @RequirePermission('documents.withdraw')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async withdraw(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @Body({ schema: withdrawalSchema }) body: z.infer<typeof withdrawalSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    switch (await this.documents.withdraw(documentId, body.reason, actorFor(session, request))) {
      case 'not_found':
        throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
      case 'not_allowed':
        throw new ForbiddenException("Only whoever added the document, or the matter's supervising partner, can withdraw it");
      case 'not_open':
        throw new ConflictException('Documents on a closed matter cannot be withdrawn');
      case 'already_withdrawn':
        throw new ConflictException(WITHDRAWN_MESSAGE);
      case 'changed':
        throw new ConflictException('The document or its matter changed meanwhile. Reload and try again');
      case 'withdrawn':
        return;
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
      withdrawal: document.withdrawal && { ...document.withdrawal, withdrawnAt: document.withdrawal.withdrawnAt.toISOString() },
    };
  }

  @Put('documents/:documentId/client-sharing')
  @RequirePermission('documents.share')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async shareWithClient(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    await this.changeSharing(documentId, true, session, request);
  }

  @Delete('documents/:documentId/client-sharing')
  @RequirePermission('documents.share')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async stopSharingWithClient(
    @Param('documentId', { schema: z.uuid() }) documentId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    await this.changeSharing(documentId, false, session, request);
  }

  private async changeSharing(documentId: string, shared: boolean, session: ResolvedSession, request: Request): Promise<void> {
    switch (await this.documents.changeSharing(documentId, shared, actorFor(session, request))) {
      case 'not_found':
        throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
      case 'withdrawn':
        throw new ConflictException('A withdrawn document cannot be shared or unshared');
      case 'changed_meanwhile':
        throw new ConflictException('The document or its matter team changed meanwhile. Reload and try again');
      case 'changed':
      case 'unchanged':
        return;
    }
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
    const result = await this.documents.download(documentId, number, actorFor(session, request));
    if (result.outcome === 'not_found') {
      throw new NotFoundException(DOCUMENT_NOT_FOUND_MESSAGE);
    }
    if (result.outcome === 'withdrawn') {
      throw new HttpException(WITHDRAWN_MESSAGE, HttpStatus.GONE);
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
