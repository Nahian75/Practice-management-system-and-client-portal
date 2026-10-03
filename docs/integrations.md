# Integrations

**Current state (2026-10-03):** One integration built.

| Service | Purpose | Data sent | Status |
|---|---|---|---|
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
