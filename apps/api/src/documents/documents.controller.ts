import {
  BadRequestException,
  ConflictException,
  Controller,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
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

const detailsSchema = z.strictObject({ title: text(200), category: z.enum(CATEGORIES) });
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
    const details = detailsSchema.safeParse(upload.fields);
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
}
