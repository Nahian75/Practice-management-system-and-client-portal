# API

**Current state (2026-10-03):** NestJS 12 skeleton in `apps/api`. One endpoint.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Liveness check for load balancers and monitoring |
| POST | `/auth/sign-in` | Public | Email and password. 200 `{"next":"two_factor"}` with a session cookie waiting for 2FA, or 401 `Email or password is incorrect` for every kind of failure |
| POST | `/auth/two-factor` | Public, but needs a session waiting for 2FA | `{"code"}`: a 6-digit authenticator code or a backup code. 200 `{"account"}` with a new session cookie. 401 `The code is incorrect` (try again) or `Please sign in again` (no waiting sign-in, 5 wrong codes, or account blocked) |
| GET | `/auth/session` | Any signed-in account | The signed-in account: id, kind, display name |
| POST | `/auth/sign-out` | Public | Ends the current session if there is one, clears the cookie. Always 204 |

`/health` returns exactly `{"status":"ok"}`. It must never return version
numbers, environment names, dependency status or anything else an attacker
could use to fingerprint the system.

## Cross-cutting behaviour

See [security.md](security.md#request-pipeline) for the full request pipeline.

## Writing a route

Every route declares who may call it, its input and its output. Without all three, it returns 500 and the handler never runs.

| Decorator | Who may call |
|---|---|
| `@Public()` | Anyone. Only for sign-in, sign-out and health |
| `@StaffOnly()` | Signed-in staff |
| `@ClientOnly()` | Signed-in clients |
| `@AnyAccount()` | Any signed-in account |

A session waiting for its 2FA code counts as not signed in.

```ts
const createClientSchema = z.strictObject({ name: z.string().min(1).max(200) });
const clientSchema = z.object({ id: z.uuid(), name: z.string() });

@Post()
@StaffOnly()
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
