import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { COUNTRY_CODES } from '../common/validation/country-codes.js';
import type { Client } from './client.js';
import { ClientsService, type ClientActor } from './clients.service.js';

// Control characters (null bytes, line breaks, tabs) and direction overrides are
// refused: a null byte cannot be stored, a line break can split a letter or an
// email header later, and an override makes a name display as something other
// than what is stored. Free text must also contain a letter or a digit, so it
// cannot be made only of invisible characters.
const UNSAFE_CHARACTERS = /[\p{Cc}‪-‮⁦-⁩]/u;
const VISIBLE_CHARACTER = /[\p{L}\p{N}]/u;

const text = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !UNSAFE_CHARACTERS.test(value), 'Contains control or text-direction characters')
    .refine((value) => VISIBLE_CHARACTER.test(value), 'Must contain a letter or a digit');
/** For creation: a field left out is stored as null. */
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
const organisationType = z.enum(['company', 'llp', 'partnership', 'charity', 'trust', 'other']);
const registrationNumber = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,30}$/);
const reference = z.string().trim().toUpperCase().regex(/^C-\d{6,}$/);

const addressSchema = z.strictObject({
  line1: text(200),
  line2: optional(text(200)),
  town: text(100),
  postcode: optional(text(16).toUpperCase()),
  country,
});

const newClientSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('individual'),
    title: optional(text(20)),
    givenNames: text(100),
    familyName: text(100),
    dateOfBirth: optional(dateOfBirth),
    email: optional(email),
    phone: optional(phone),
    address: optional(addressSchema),
  }),
  z.strictObject({
    kind: z.literal('organisation'),
    legalName: text(200),
    organisationType,
    registrationNumber: optional(registrationNumber),
    email: optional(email),
    phone: optional(phone),
    address: optional(addressSchema),
  }),
]);

/** For changes: a field left out stays as it is, and null clears an optional field. */
const atLeastOneChange = (patch: object) => Object.keys(patch).length > 1;
const clientPatchSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('individual'),
      title: text(20).nullable().optional(),
      givenNames: text(100).optional(),
      familyName: text(100).optional(),
      dateOfBirth: dateOfBirth.nullable().optional(),
      email: email.nullable().optional(),
      phone: phone.nullable().optional(),
      address: addressSchema.nullable().optional(),
    })
    .refine(atLeastOneChange, 'Nothing to change'),
  z
    .strictObject({
      kind: z.literal('organisation'),
      legalName: text(200).optional(),
      organisationType: organisationType.optional(),
      registrationNumber: registrationNumber.nullable().optional(),
      email: email.nullable().optional(),
      phone: phone.nullable().optional(),
      address: addressSchema.nullable().optional(),
    })
    .refine(atLeastOneChange, 'Nothing to change'),
]);

const newContactSchema = z.strictObject({
  givenNames: text(100),
  familyName: text(100),
  jobTitle: optional(text(100)),
  email: optional(email),
  phone: optional(phone),
});

const contactPatchSchema = z
  .strictObject({
    givenNames: text(100).optional(),
    familyName: text(100).optional(),
    jobTitle: text(100).nullable().optional(),
    email: email.nullable().optional(),
    phone: phone.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Nothing to change');

const takeOverSchema = z.strictObject({ reason: text(500, 10) });

const listQuerySchema =z.strictObject({ before: reference.optional() });
const searchQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(100) });

const createdSchema = z.object({
  id: z.uuid(),
  reference: z.string(),
});

const summarySchema = z.object({
  id: z.uuid(),
  reference: z.string(),
  kind: z.enum(['individual', 'organisation']),
  name: z.string(),
});
const listSchema = z.object({ clients: z.array(summarySchema), next: z.string().nullable() });
const searchSchema = z.object({ clients: z.array(summarySchema) });

const contactSchema = z.object({
  id: z.uuid(),
  givenNames: z.string(),
  familyName: z.string(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  active: z.boolean(),
});
const contactAddedSchema = z.object({ id: z.uuid() });

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
    contacts: z.array(contactSchema),
    ...clientRecordFields,
  }),
]);

export const CLIENT_NOT_FOUND_MESSAGE = 'No client with this id';

function actorFor(session: ResolvedSession, request: Request): ClientActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

const serialise = (client: Client) => ({ ...client, createdAt: client.createdAt.toISOString() });

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

  @Get()
  @RequirePermission('clients.view')
  @ResponseSchema(listSchema)
  list(@Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>, @CurrentSession() session: ResolvedSession) {
    return this.clients.list(session.account.id, query.before);
  }

  /** Searches every client, but returns only what is needed to recognise one. */
  @Get('search')
  @RequirePermission('clients.search')
  @ResponseSchema(searchSchema)
  async search(@Query({ schema: searchQuerySchema }) query: z.infer<typeof searchQuerySchema>) {
    return { clients: await this.clients.search(query.q) };
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
    return serialise(client);
  }

  @Patch(':clientId')
  @RequirePermission('clients.edit')
  @ResponseSchema(clientSchema)
  async update(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: clientPatchSchema }) body: z.infer<typeof clientPatchSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.clients.update(clientId, body, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
      case 'kind_mismatch':
        throw new BadRequestException(`This client is an ${result.kind}`);
      case 'updated':
        return serialise(result.client);
    }
  }

  @Post(':clientId/contacts')
  @RequirePermission('clients.edit')
  @ResponseSchema(contactAddedSchema)
  async addContact(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: newContactSchema }) body: z.infer<typeof newContactSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.clients.addContact(clientId, body, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
      case 'not_organisation':
        throw new ConflictException('Only organisation clients have contacts');
      case 'added':
        return { id: result.contactId };
    }
  }

  @Patch(':clientId/contacts/:contactId')
  @RequirePermission('clients.edit')
  @ResponseSchema(contactSchema)
  async updateContact(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Param('contactId', { schema: z.uuid() }) contactId: string,
    @Body({ schema: contactPatchSchema }) body: z.infer<typeof contactPatchSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.clients.updateContact(clientId, contactId, body, actorFor(session, request));
    if (result.outcome === 'not_found') {
      throw new NotFoundException('No contact with this id for this client');
    }
    return result.contact;
  }

  /** Answers for clients the caller cannot see: a partner finds them through search. */
  @Post(':clientId/take-over')
  @RequirePermission('clients.take_over')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async takeOver(
    @Param('clientId', { schema: z.uuid() }) clientId: string,
    @Body({ schema: takeOverSchema }) body: z.infer<typeof takeOverSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    switch (await this.clients.takeOver(clientId, body.reason, actorFor(session, request))) {
      case 'not_found':
        throw new NotFoundException(CLIENT_NOT_FOUND_MESSAGE);
      case 'responsible_active':
        throw new ConflictException('The person responsible for this client is still active');
      case 'taken_over':
        return;
    }
  }
}
