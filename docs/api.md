# API

**Current state (2026-10-03):** NestJS 12 skeleton in `apps/api`. One endpoint.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | None | Liveness check for load balancers and monitoring |

`/health` returns exactly `{"status":"ok"}`. It must never return version
numbers, environment names, dependency status or anything else an attacker
could use to fingerprint the system.

## Cross-cutting behaviour

See [security.md](security.md#request-pipeline) for the full request pipeline.

## Writing a route

Every route declares its input and output. Without both, it returns 500.

```ts
const createClientSchema = z.strictObject({ name: z.string().min(1).max(200) });
const clientSchema = z.object({ id: z.uuid(), name: z.string() });

@Post()
@ResponseSchema(clientSchema)
create(@Body({ schema: createClientSchema }) body: z.infer<typeof createClientSchema>) {
  return this.clients.create(body);
}
```

- Request schemas: `z.strictObject` (unknown fields rejected).
- Response schemas: `z.object` (undeclared fields removed).
- Route IDs: `@Param('id', { schema: z.uuid() })`.

## Error format

```json
{ "statusCode": 403, "message": "You do not have access to this matter" }
{ "statusCode": 500, "message": "Internal Server Error", "reference": "<uuid>" }
```

## Running locally

```sh
cp apps/api/.env.example apps/api/.env
npm run build -w @practice/api
npm run start:local -w @practice/api
```
