# Integrations

**Current state (2026-10-07):** Two integrations built. Notifications step
13a replaced the process-local email queue with a persistent encrypted outbox.

| Service | Purpose | Data sent | Status |
|---|---|---|---|
| SMTP email provider | Invitations, password resets, security notices | Recipient address, subject, plain-text body (may contain one-time links) | Built. Provider not chosen; Mailpit locally |
| Have I Been Pwned, Pwned Passwords range API | Reject passwords known from data breaches | First 5 hex characters of the password's SHA-1 hash. Never the password, never the email | Built (`apps/api/src/auth/passwords/breached-password-checker.ts`) |

## Have I Been Pwned

- Endpoint: `https://api.pwnedpasswords.com/range/{first 5 hash characters}`.
  Free, no API key. Response padding enabled (`Add-Padding: true`) so the
  response size does not hint at the result.
- k-anonymity: the service returns every leaked hash starting with those 5
  characters (hundreds); the match is done on our server. The service cannot
  tell which password was checked.
- Timeout 3 seconds. If unreachable, the password is accepted and the skip is
  logged. An outage must not block account set-up.

## Email (SMTP)

- `apps/api/src/mail/mailer.ts`, configured by `SMTP_URL`,
  `MAIL_FROM_ADDRESS` and `MAIL_FROM_NAME`. The queue is encrypted under the
  separate `MAIL_ENCRYPTION_KEY`.
- Production: `smtps://` (implicit TLS) or `smtp://` with STARTTLS required.
  The server certificate is always verified; TLS 1.2 minimum.
- Every message is checked before sending: exactly one valid recipient, a
  one-line subject. Tested: without the recipient check, nodemailer itself
  delivered mail to an address injected with `
Bcc:`.
- Message bodies are never logged: they carry one-time links.
- Messages share a pool of at most 3 SMTP connections and queue for them, so a
  burst (one notice per compliance holder) does not open a connection per
  message. Without the pool, a burst made Mailpit stop answering and other
  emails sent at the same moment were lost.
- Locally, Mailpit catches everything at http://127.0.0.1:8025. No email leaves the machine.
- Open: which provider, and its data-processing agreement and data location.
- `email_outbox` keeps mail through an API restart. The address, subject and
  body are AES-256-GCM ciphertext; PostgreSQL holds no readable copy. Several
  API instances claim due rows with short leases and `FOR UPDATE SKIP LOCKED`.
- Temporary failures retry after 1 minute, 5 minutes, 30 minutes, 2 hours and
  then at most every 6 hours. Delivery finally fails after 24 hours. Invalid
  or permanently refused messages fail without retry. Successful, stale and
  finally failed rows have their encrypted payload cleared.
- Queue and outcome audit records contain the outbox id, kind and safe
  account/resource ids only. Provider errors, addresses, subjects and bodies
  are neither logged nor audited. Details are in
  [notifications.md](notifications.md). Authentication review item F5 is
  closed.
