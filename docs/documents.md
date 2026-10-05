# Documents

**Current state (2026-10-05):** Steps 10a to 10b-4 built: storage and scanner
containers, file encryption, the tables (migration `0024`), file inspection,
uploading, listing and downloading documents, all in `apps/api/src/documents/`.
Versions and withdrawal (step 10c) next. Compliance access to documents, through
the matter's compliance access, is not built yet.

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

## How a file's type is checked

`FileInspection` reads the file as it streams, passing it on unchanged:

- **The name decides what the file must be:** `.pdf`, `.docx`, `.xlsx`,
  `.pptx`, `.txt`, `.eml`, `.jpg`/`.jpeg`, `.png`, in any case. Any other
  extension (`.html`, `.svg`, `.js`, the old `.doc`, the macro-enabled
  `.docm`) is refused without looking further.
- **The content must agree.** PDF, JPEG and PNG by their first bytes (checked
  as soon as they arrive, so a mismatch stops the upload at once). Word, Excel
  and PowerPoint files are ZIP files: their table of contents, at the end of
  the file, must list `[Content_Types].xml` and the right main part
  (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`), and no
  `vbaProject.bin` (macros). Text and emails must be valid UTF-8 with no null
  bytes; an email must start with a header line.
- **A file that disagrees is refused, never relabelled.** The stored type comes
  from the name only once the content has confirmed it.
- Size is counted as it arrives and the upload stopped as soon as it passes
  50 MB; the SHA-256 fingerprint is computed on the way.

## Upload, step by step

1. The browser sends a multipart form through the web app's `/api`
   pass-through: `title` and `category` first, then one file called `file`.
   Anything else (a second file, a late or unknown field) refuses the upload.
   The file is read as a stream, never held whole in memory
   (`upload-request.ts`, using busboy).
2. The API checks the person is on the matter's team (otherwise 404, as if it
   did not exist) and the matter is open (otherwise 409), before reading the file.
3. As the file arrives, three things happen to it at once: it is inspected
   (size, type, fingerprint: `FileInspection`), scanned (ClamAV), and
   encrypted into storage (`DocumentVault`). If any of them stops, the others
   are stopped too, and the first to stop explains the refusal. The file
   handed over ends only once the whole form has been read and found as
   expected.
4. Only when the inspection passes, the scan is clean and the file is stored
   are the document and its first version recorded, with `document.added`, in
   one transaction; the database checks the team and the matter once more.
   Otherwise anything already stored is removed, the refusal is recorded as
   `document.refused` with its reason, and for malware every compliance holder
   is emailed (by matter reference, without the file's name).
5. A refused upload is answered with `Connection: close`, so the rest of a
   large upload is not read.

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
| POST | `/matters/:id/documents` | `documents.add` + team, open matter | Multipart: `title`, `category`, then `file` → 201 with the document and its version 1. 400 form, title, category, empty file, file name, or interrupted; 404 not on the team; 409 matter not open; 413 over 50 MB; 415 type not accepted, or macros; 422 malware (compliance told); 503 scanner unavailable (nothing unscanned is stored) |
| GET | `/matters/:id/documents` | `documents.view` + team | `{documents, next}`: 100 at a time, newest first, each with its latest version; `?before=<next>` for the next page. 404 if not on the team |
| GET | `/documents/:id` | `documents.view` + team | The document and every version, with who uploaded each. 404 if not on the team |
| POST | `/documents/:id/versions` | `documents.add` + team, open matter | Multipart: `file` → 201 with the new version |
| GET | `/documents/:id/versions/:number/content` | `documents.view` + team | The file, decrypted as it is sent. Always `Content-Disposition: attachment` (the exact name encoded, and a plain fallback), its `Content-Length`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. Recorded before it is sent. If the stored file fails its integrity check part-way, the connection is cut, so the browser reports a failed download rather than saving altered content. 404 if not on the team |
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
- **10b-2.** File inspection: size, fingerprint, and type from content. Done.
- **10b-3.** Uploading a document: streaming, scanning, storing, audit, and
  compliance told of malware. Done. The web app's pass-through limits request
  bodies, so step 10d raises its limit for this route.
- **10b-4.** Listing and downloading documents. Done.
- **10c.** Versions and withdrawal.
- **10d.** The document screens in the staff web app.
- Security review of the module.
