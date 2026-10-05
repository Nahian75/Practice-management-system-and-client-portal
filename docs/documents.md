# Documents

**Current state (2026-10-05):** Steps 10a and 10b-1 built: storage and scanner
containers, file encryption, the tables (migration `0024`), and the API's
connections to storage and scanner (`ObjectStorage`, `DocumentVault`,
`VirusScanner` in `apps/api/src/documents/`). No routes yet; step 10b-2 next.

The files of a matter: letters, contracts, evidence, identity documents,
emails. Documents come before the client portal, so clients have something to
see there.

## Decisions

| Topic | Decision | Decided by |
|---|---|---|
| Where files are kept | Private S3-compatible object storage, never reachable from the internet; details (title, matter, versions) in PostgreSQL. Locally, SeaweedFS in Docker (MinIO, first proposed, no longer publishes its community images). S3-compatible keeps the hosting choice open, including UK-only storage | Project owner |
| Encryption | The API encrypts every file before storing it: AES-256-GCM, a new key for each file, that key itself encrypted with a master key the storage never holds. A copy of the storage alone reveals nothing. Closes review item C6 for documents | Project owner |
| Malware | Every upload is scanned (ClamAV, run locally in Docker) before it is stored. An infected file is refused, never stored, and compliance is emailed. If the scanner cannot be reached, uploads are refused: no unscanned file is ever stored | Project owner |
| Allowed files | PDF; Word, Excel, PowerPoint (current formats only, no macro-enabled ones); plain text; JPEG, PNG; emails (`.eml`). The type is read from the file's content, not its name. At most 50 MB | Project owner |
| Versions | A new version never replaces the old: every version is kept and can be downloaded | Rule: records are kept |
| Deleting | Never. A document added by mistake is withdrawn, with a reason: hidden from the list, kept, audited | Rule: records are kept |
| Who sees and adds documents | The matter's team only, as for the matter. Compliance through the existing compliance access, with its reason | Project owner (follows Matters) |
| Who withdraws | Whoever uploaded it, or the matter's supervising partner | Project owner |
| Closed matters | Documents stay readable; nothing can be added, versioned or withdrawn | Project owner (follows Matters) |
| Downloads | Through the API only, always as a download, never displayed in the browser (a file cannot then run script on the app's site). Every download is audited | Project owner |
| Sharing with the client | Every document is staff-only. A team member can mark one "shared with the client"; the portal later shows only those. Built with the portal | Project owner |

## What a document holds

- **Matter**, fixed.
- **Title** (up to 200 characters) and a **category**: correspondence, contract,
  evidence, identity, court, other.
- **Versions**, numbered from 1. Each version: the original file name (kept
  only as text, never used as a path), type, size, a SHA-256 fingerprint of
  the file, who uploaded it and when.
- **Withdrawn:** when, by whom and why, if it was.

## Tables

- `documents`: `id`, `matter_id`, `title`, `category`, `created_by`,
  `created_at`. Withdrawal (`withdrawn_at`, `withdrawn_by`,
  `withdrawal_reason`) comes with step 10c.
- `document_versions`: `id`, `document_id`, `number`, `file_name`,
  `media_type`, `size_bytes`, `sha256`, `storage_key`, and the sealed file
  key (`key_version`, `key_nonce`, `wrapped_key`, `key_tag`), `uploaded_by`,
  `uploaded_at`. Insert only: the app role cannot change or delete a version,
  nor choose its number.
- The database itself refuses: a document or version from anyone not an active
  member of the matter's team; any on a matter that is not open (awaiting
  conflict clearance, or closed); a document without a version (checked at
  commit); version numbers out of order (numbered under a per-document lock);
  a file name with a slash, backslash or control character; a type not
  allowed; an empty file or one over 50 MB.
- The storage key is a random id, not the file name or anything about the
  client, so the storage listing reveals nothing.

## Encryption

- Each file gets a new random 256-bit key. The file is encrypted in fixed-size
  chunks with AES-256-GCM, each chunk authenticated, so a large file is never
  held whole in memory and any change to the stored bytes is detected on
  download.
- The file's key is encrypted ("wrapped") with the master key and kept in
  `document_versions.wrapped_key`. The master key comes from configuration
  (`DOCUMENT_ENCRYPTION_KEY`) now, and from a key management service in
  production; changing it means re-wrapping the small file keys, not
  re-encrypting files.
- The storage holds only encrypted bytes; the database holds only wrapped keys.
  Neither alone opens a file.

## Upload, step by step

1. The browser sends the file through the web app's `/api` pass-through.
2. The API checks the matter is visible, open, and the person is on its team.
3. While the file arrives: it counts the size (stops at 50 MB), reads its type
   from the first bytes, computes its fingerprint, sends it to the scanner,
   and encrypts it into storage.
4. Only when the scan is clean, the type allowed and the size within the limit
   is the version recorded in the database, with its audit record, in one
   transaction. Otherwise the stored bytes are removed and the upload refused.

## Who can do what

| Permission | Administrator | Partner | Fee earner | Accounts | Compliance |
|---|---|---|---|---|---|
| `documents.view` — list and download documents of your matters | | ✓ | ✓ | | |
| `documents.add` — add documents and versions to your open matters | | ✓ | ✓ | | |
| `documents.withdraw` — withdraw your own upload, or any on a matter you supervise | | ✓ | ✓ | | |

As for matters, a permission is never enough on its own: every query filters by
the matter's team, and a document you may not see answers 404.

## API

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/matters/:id/documents` | `documents.add` + team, open matter | Multipart: `file`, `title`, `category` → 201 with the document. 413 too large, 415 type not allowed, 422 malware found, 503 scanner unavailable |
| GET | `/matters/:id/documents` | `documents.view` + team | Documents not withdrawn, newest first, with the latest version |
| GET | `/documents/:id` | `documents.view` + team | The document and every version |
| POST | `/documents/:id/versions` | `documents.add` + team, open matter | Multipart: `file` → 201 with the new version |
| GET | `/documents/:id/versions/:number/content` | `documents.view` + team | The file, decrypted, as an attachment with `X-Content-Type-Options: nosniff` |
| POST | `/documents/:id/withdrawal` | `documents.withdraw` + uploader or supervising partner, open matter | `{reason}` (10 to 500 characters) → 204 |

## Audit

`document.added` (document id, version, type, size), `document.version_added`,
`document.downloaded` (document id, version), `document.withdrawn`,
`document.refused` (reason: too large, type, malware, scanner unavailable).
Never file names, titles or contents: like client names, they can be personal
data.

## Local services

Two more containers in `compose.yaml`, pinned by digest, bound to `127.0.0.1`:
SeaweedFS 4.47 (storage, S3 on `127.0.0.1:8333`) and ClamAV 1.5.4 (scanner, on
`127.0.0.1:3310`, with its virus definitions updated by the container itself).
SeaweedFS requires the access key from `.env` and refuses anonymous requests
(checked: 403). It creates one bucket per database: `pms-documents`,
`pms-documents-test`, `pms-documents-e2e`. ClamAV was checked with the
standard EICAR test file (found) and a clean file (passed). The API's settings
are `DOCUMENTS_S3_*`, `DOCUMENT_ENCRYPTION_KEY` and `CLAMAV_*` in
`apps/api/.env`; the storage endpoint must be https in production. ClamAV's
daemon has no authentication, so in production it must be on a private network. Both versions were
at least seven days old when pinned, as for npm packages.

## Not in this module

- Showing documents to clients: the portal.
- Previews in the browser, text search inside documents, and editing: later,
  each with its own security review (they mean opening untrusted files on the
  server).
- Retention and disposal: with Compliance (review item F3).

## Build order

Each step ships with positive and negative tests and is reviewed before the next.

- **10a.** SeaweedFS and ClamAV containers; file encryption and decryption, with
  tests (no routes yet). Done.
- **10b-1.** The tables; the API's connections to storage (encrypting as it
  stores, `DocumentVault`) and to the scanner (failing closed). Done.
- **10b-2.** Uploading, listing and downloading documents on a matter, with
  scanning, type and size checks, and audit.
- **10c.** Versions and withdrawal.
- **10d.** The document screens in the staff web app.
- Security review of the module.
