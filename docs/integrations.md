# Integrations

**Current state (2026-10-04):** Two integrations built.

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

- `apps/api/src/mail/mailer.ts`, configured by `SMTP_URL`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`.
- Production: `smtps://` (implicit TLS) or `smtp://` with STARTTLS required.
  The server certificate is always verified; TLS 1.2 minimum.
- Every message is checked before sending: exactly one valid recipient, a
  one-line subject. Tested: without the recipient check, nodemailer itself
  delivered mail to an address injected with `
Bcc:`.
- Message bodies are never logged: they carry one-time links.
- Locally, Mailpit catches everything at http://127.0.0.1:8025. No email leaves the machine.
- Open: which provider, and its data-processing agreement and data location.
