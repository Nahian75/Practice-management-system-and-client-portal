import { BadRequestException, Controller, Get, HttpException, HttpStatus, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { readUpload, UploadFormError } from '../documents/upload-request.js';
import { MAX_SANCTIONS_LIST_BYTES } from './sanctions-list.js';
import type { SanctionsListVersion } from './sanctions.repository.js';
import { SanctionsService } from './sanctions.service.js';

const date = z.iso.date();
const versionSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), reportDate: date,
  source: z.enum(['download', 'upload']), designationCount: z.number().int(), nameCount: z.number().int(),
  importedAt: z.iso.datetime() });
const statusSchema = z.object({ listId: z.uuid().nullable(), version: z.number().int().nullable(), reportDate: date.nullable(),
  lastSuccessAt: z.iso.datetime().nullable(), lastFailureAt: z.iso.datetime().nullable(), fresh: z.boolean() });
const importSchema = z.object({ outcome: z.enum(['imported', 'unchanged']), list: versionSchema });
const versionPage = z.object({ lists: z.array(versionSchema), next: z.uuid().nullable() });
const pageQuery = z.strictObject({ before: z.uuid().optional() });

const serializeVersion = (value: SanctionsListVersion) => ({ ...value, importedAt: value.importedAt.toISOString() });

@Controller('compliance/sanctions')
export class SanctionsController {
  constructor(private readonly sanctions: SanctionsService) {}

  @Get('status') @RequirePermission('aml.sanctions') @ResponseSchema(statusSchema)
  async status() {
    const value = await this.sanctions.status();
    return { ...value, lastSuccessAt: value.lastSuccessAt?.toISOString() ?? null, lastFailureAt: value.lastFailureAt?.toISOString() ?? null };
  }

  @Get('lists') @RequirePermission('aml.sanctions') @ResponseSchema(versionPage)
  async lists(@Query({ schema: pageQuery }) query: z.infer<typeof pageQuery>) {
    const page = await this.sanctions.listVersions(query.before);
    return { lists: page.items.map(serializeVersion), next: page.next };
  }

  /** A manual upload of the official CSV, for when the scheduled download is unavailable. */
  @Post('lists') @RequirePermission('aml.sanctions') @ResponseSchema(importSchema)
  async upload(@CurrentSession() session: ResolvedSession, @Req() request: Request) {
    let upload;
    try {
      upload = await readUpload(request, [], MAX_SANCTIONS_LIST_BYTES);
    } catch (error) {
      if (error instanceof UploadFormError) throw new BadRequestException(error.message);
      throw error;
    }
    const result = await this.sanctions.importList(upload.file, {
      actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request),
    });
    if (result.outcome === 'refused') {
      if (result.reason === 'too_large') throw new HttpException('The sanctions list file is too large', HttpStatus.PAYLOAD_TOO_LARGE);
      if (result.reason === 'older_report') throw new HttpException('A newer sanctions list is already active', HttpStatus.CONFLICT);
      throw new HttpException('The file is not the official UK Sanctions List CSV', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return { outcome: result.outcome, list: serializeVersion(result.list) };
  }
}
