# Security review: documents module

**Date:** 2026-10-06
**Scope:** `apps/api/src/documents/` (inspection, scanning, encryption, storage,
routes), migrations `0024` and `0025`, the SeaweedFS and ClamAV containers, the
document screens in `apps/web`, and the web app's request-body limit. Commits
`56e12ad`…`5dc384c`.
**Method:** code read; each safeguard confirmed by breaking it on purpose during
the build and checking a test fails; probes against the real ClamAV and
SeaweedFS containers and the app, with synthetic files; Next.js's own
pass-through code read (`body-streams.js`, `router-server.js`); ClamAV's
effective configuration read from the container.

## Findings

### D1 — Office files can fetch or carry active content without macros of their own

| | |
|---|---|
| Severity | **Medium** |
| Location | `FileInspection` (Word, Excel, PowerPoint) |
| Problem | Inspection refuses Office files containing macros (`vbaProject.bin`), but not files that point to a **remote template** (a relationship with `TargetMode="External"`), which Word fetches when the file is opened, macros included; nor files carrying **embedded objects** (`word/embeddings/…`, OLE packages that can hold programs). |
| Impact | **Probe:** a `.docx` with an external `attachedTemplate` relationship and an embedded object starting `MZ` (a Windows program) was accepted by the inspection and reported clean by ClamAV. Downloaded and opened by a colleague, it could run code on their computer. Uploading needs a staff account on the matter's team, but the file itself often comes from outside (a client, the other side). |
| Fix | **Fixed after the review** (`office-content.ts`). As the file streams, a copy is kept of every entry that looks like a relationships part (`*.rels`; at most 256 KB each, 4 MB in all); at the end, the table of contents decides which are real, and those are read as an XML parser would (any prefix, either quote, character references, UTF-16). Refused: any external relationship other than a hyperlink, unless it points to a file on the local disk (`file:///C:/…`, as templates from a firm's own template folder do); a relationship to macros, whatever the macro part is called; embedded objects that can hold programs (`/embeddings/` `.bin` and macro-enabled files) and ActiveX controls. Allowed: hyperlinks, embedded chart workbooks (`.xlsx`), Excel's printer settings. A relationships part that cannot be read for certain is refused. |
| Test | `file-inspection.spec.ts`, "Office files that bring in active content": the probe's file and each kind refused; the tricks above; a part cut at every position across the pieces a file arrives in; the allowed cases. `documents.controller.spec.ts`: refused through the route (415), audited, nothing stored. Ignoring external links, reading tags naively, not decoding references, or not carrying bytes across pieces each fails a test. |

### D2 — The web app keeps a copy of every request body in memory, now up to 52 MB, for anyone

| | |
|---|---|
| Severity | **Medium** (availability) |
| Location | The `/api` pass-through; `proxyClientMaxBodySize` (raised from 10 MB to 52 MB in step 10d) |
| Problem | For a pass-through request, Next.js streams the body on to the API and also keeps a full copy in memory until the request ends (`body-streams.js`, `cloneBodyStream`). This applies to every `/api` address, before the API has checked who is asking. |
| Impact | Anyone who can reach the site, signed in or not, can make the web server hold up to 52 MB per open request by sending large bodies to any `/api` address. Many at once could exhaust its memory. Raising the limit for uploads made each request five times as costly. |
| Fix | Proposed, in two layers. (1) The web app's proxy refuses, with 413 and before passing anything on, a declared body over 1 MB to any `/api` address other than the two upload routes. (2) Deployment rule: the reverse proxy allows 52 MB only on those two paths and 1 MB elsewhere, and limits connections per client. Layer 2 is the one that holds against bodies sent without a declared length. |

### D3 — ClamAV reports content it did not fully scan as clean

| | |
|---|---|
| Severity | **Low** |
| Location | ClamAV's configuration (container defaults) |
| Problem | `AlertExceedsMax` is off by default: content past ClamAV's limits (an archive entry over 100 MB unpacked, too many files, too deep) is skipped and the file reported clean. |
| Impact | **Probe:** in a `.docx` holding a 420 MB entry (419 KB packed), ClamAV skipped that entry and still found the EICAR test file in the next one, so the risk is narrower than it first appears: only content *inside* an over-large entry goes unscanned. That content is still in the file people download. |
| Fix | Proposed: `AlertExceedsMax yes` in a ClamAV configuration file mounted into the container, so such files are reported (`Heuristics.Limits.Exceeded…`); the API refuses them with their own reason ("could not be fully checked"), and compliance is not emailed for these, as they are not malware. |

### D4 — No limit on how much one person uploads

| | |
|---|---|
| Severity | **Low** |
| Location | `POST /matters/:id/documents`, `POST /documents/:id/versions` |
| Problem | Nothing limits the number or size of uploads per person. |
| Impact | A misused or taken-over staff account could fill the storage (50 MB at a time); every upload is audited, so it would be seen afterwards, not stopped. |
| Fix | Proposed: an hourly allowance per person (for example 200 files or 2 GB), counted from the audit records as for compliance access (review M4), with administrators alerted once when it is reached. |

### D5 — Stored bytes can be left behind

| | |
|---|---|
| Severity | **Low** |
| Location | `DocumentsService.receive`, `accept` |
| Problem | If the API stops between storing a file and recording it, or removing the bytes of a refused upload fails, the encrypted bytes stay in storage with no record. |
| Impact | They cannot be read (the file's key was never saved), but take space. |
| Fix | Accepted until production; then a daily sweep removing objects older than a day that no version names. |

### D6 — Accepted, and items for later

| | |
|---|---|
| Severity | **Information** |
| Items | **Downloads per person are not limited:** a team member may download their matters' documents; each download is audited. **Master key rotation** is not built (each sealed key records its key version, so it can be added). **Compliance access to documents** through the matter's compliance access is not built. **Virus definitions** update themselves in the container; in production their age must be monitored. **PDFs** are checked by their first bytes only, and may carry script for PDF readers; downloads are attachments under a sandboxing policy, so a browser never runs them, and ClamAV scans them. |

## Checked and in order

- **Encryption:** each file under its own key, sealed with the master key and bound to its storage key; the storage holds only encrypted bytes (probe: no plaintext in stored objects). Changed, reordered, repeated, foreign or truncated chunks are refused (tests, and deliberate breaks).
- **Downloads:** a stored file that fails its integrity check cuts the connection, never sending altered content as complete (test, with a break showing the test tells the two apart). Always an attachment, with `nosniff`, `no-store` and `Content-Security-Policy: default-src 'none'; sandbox`; the file name cannot break the header (tests).
- **Access:** every route filters by the matter's team in its query; anyone else gets 404, as for a document that does not exist (tests; removing the check from downloads fails a test). Withdrawn documents are not listed or downloaded. The database enforces the team, open matters, numbering, withdrawal rules and insert-only versions on its own.
- **Uploads:** type from content, never relabelled; macros refused; 50 MB counted as it arrives; the form must be exactly the fields then one file; anything refused leaves nothing stored (tests with storage tracked). Uploads fail closed when the scanner cannot be reached.
- **Scanner:** 25 slow uploads held open did not slow a normal scan (34 ms; probe): ClamAV collects streams without holding its scanning threads. Archives are scanned past an over-large entry (probe).
- **Storage:** not reachable from outside the machine; anonymous requests refused (probe: 403); keys are random ids, never names.
- **Audit and logs:** ids, versions, types and sizes only; never titles, file names or contents; withdrawal reasons kept with the withdrawal, not in the audit log.
- **Forged requests:** uploads and withdrawals are `POST`, covered by the API's cross-site check like every other change.
- **Dependencies:** `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` and `busboy`, each at least seven days old; `npm audit`: no known vulnerabilities.
