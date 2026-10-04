import { Body, Controller, Get, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { COUNTRY_CODES } from '../common/validation/country-codes.js';
import { ClientsService, type ClientActor } from './clients.service.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? null);

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{6,30}$/, 'Digits, spaces, brackets and dashes, optionally starting with +');
const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/)
  .refine((code) => COUNTRY_CODES.has(code), 'Not an ISO 3166 country code');
const dateOfBirth = z.iso
  .date()
  .refine((date) => date >= '1900-01-01' && date <= new Date().toISOString().slice(0, 10), 'Not a plausible date of birth');

const addressSchema = z.strictObject({
  line1: text(200),
  line2: optional(text(200)),
  town: text(100),
  postcode: optional(text(16).toUpperCase()),
  country,
});

const contactFields = {
  email: optional(email),
  phone: optional(phone),
  address: optional(addressSchema),
};

const newClientSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('individual'),
    title: optional(text(20)),
    givenNames: text(100),
    familyName: text(100),
    dateOfBirth: optional(dateOfBirth),
    ...contactFields,
  }),
  z.strictObject({
    kind: z.literal('organisation'),
    legalName: text(200),
    organisationType: z.enum(['company', 'llp', 'partnership', 'charity', 'trust', 'other']),
    registrationNumber: optional(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,30}$/)),
    ...contactFields,
  }),
]);

const createdSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
});

const clientRecordFields = {
  id: z.uuid(),
  reference: z.string(),
  status: z.enum(['active', 'archived']),
  createdAt: z.iso.datetime(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z
    .object({
      line1: z.string(),
      line2: z.string().nullable(),
      town: z.string(),
      postcode: z.string().nullable(),
      country: z.string(),
    })
    .nullable(),
};

const clientSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('individual'),
    title: z.string().nullable(),
    givenNames: z.string(),
    familyName: z.string(),
    dateOfBirth: z.string().nullable(),
    ...clientRecordFields,
  }),
  z.object({
    kind: z.literal('organisation'),
    legalName: z.string(),
    organisationType: z.string(),
    registrationNumber: z.string().nullable(),
    ...clientRecordFields,
  }),
]);

export const CLIENT_NOT_FOUND_MESSAGE = 'No client with this id';

function actorFor(session: ResolvedSession, request: Request): ClientActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Post()
  @RequirePermission('clients.create')
  @ResponseSchema(createdSchema)
  create(
    @Body({ schema: newClientSchema }) body: z.infer<typeof newClientSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    return this.clients.create(body, actorFor(session, request));
  }

  /** A client the caller may not see answers 404, like one that does not exist. */
  @Get(':clientId')
  @RequirePermission('clients.view')
  @ResponseSchema(clientSchema)
  async find(@Param('clientId', { schema: z.uuid() }) clientId: string, @CurrentSession() session: ResolvedSession) {
    const client = await this.clients.find(clientId, session.account.id);
    if (!client) {
      throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
    }
    return { ...client, createdAt: client.createdAt.toISOString() };
  }
}
