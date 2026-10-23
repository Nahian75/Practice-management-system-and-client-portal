# Document Security

**Current state:** built. This page is a summary; the detail, with the reasons,
is in [documents.md](documents.md).

## Controls

| Risk | Control | Detail |
|---|---|---|
| A copy of the storage is stolen | Every file is encrypted by the API before it is stored (AES-256-GCM, a new key per file, that key wrapped by a master key the storage never holds) | [Encryption](documents.md#encryption) |
| A file is altered in storage | Each encrypted chunk is authenticated; a failed check part-way cuts the download, so no altered file is saved | [API](documents.md#api) |
| Malware | Every upload is scanned by ClamAV before it is stored. Infected files are refused and compliance is emailed. If the scanner is down, uploads are refused | [Upload, step by step](documents.md#upload-step-by-step) |
| A dangerous file type, or one renamed to look safe | The type is read from the content, not the name. Only PDF, current Office formats without macros or active content, plain text, JPEG, PNG and `.eml` are accepted, up to 50 MB | [How a file's type is checked](documents.md#how-a-files-type-is-checked) |
| A downloaded file runs in the browser | Always sent as an attachment, with `nosniff` and a sandboxing Content-Security-Policy | [API](documents.md#api) |
| Someone not on the matter reads a file | Every query filters by the matter's team; anything else answers 404. Compliance reads a file only through a recorded compliance access, with a reason for each download | [Who can do what](documents.md#who-can-do-what) |
| Bulk upload abuse | At most 200 files or 2 GB per person an hour, then refused and administrators are emailed | [Upload allowance](documents.md#upload-allowance) |
| A trail is missing | Uploads, downloads, refusals, sharing and withdrawals are audited | [Audit](documents.md#audit) |

## Separate boundaries

Compliance evidence, restricted-report attachments and HR files reuse the same
inspection, scanning and cipher, but each has its own encryption key, storage
namespace, tables and access rules. None of them can become an ordinary matter
document or reach the client portal. See [Encryption](documents.md#encryption).

## Not yet covered

- The master keys come from configuration. Production must hold them in a key
  management service ([deployment.md](deployment.md)).
- Clients cannot upload through the portal yet ([portal.md](portal.md#decisions)).
