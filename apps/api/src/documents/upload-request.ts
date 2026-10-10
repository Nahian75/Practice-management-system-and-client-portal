import { PassThrough, type Readable } from 'node:stream';
import busboy from 'busboy';
import type { Request } from 'express';
import { MAX_DOCUMENT_BYTES } from './file-inspection.js';

const MAX_FIELD_BYTES = 1024;

/** The upload is not a form this route accepts; nothing of it is kept. */
export class UploadFormError extends Error {
  override readonly name = 'UploadFormError';
}

export interface Upload {
  fields: Record<string, string>;
  /** The file's name as the browser gave it, without any folder. */
  fileName: string;
  /** The file itself, still arriving: read it once, as a stream. */
  file: Readable;
}

/**
 * Reads a multipart upload: the named text fields first, then one file,
 * called `file`. The file is handed over as it starts to arrive, never held
 * whole in memory. Busboy stops a file at one byte past the limit (50 MB for
 * documents), so whatever reads it always sees that it is too large.
 */
export function readUpload(request: Request, fieldNames: readonly string[], maxFileBytes = MAX_DOCUMENT_BYTES): Promise<Upload> {
  return new Promise((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: request.headers,
        defParamCharset: 'utf8',
        limits: {
          files: 1,
          fields: fieldNames.length,
          fieldNameSize: 50,
          fieldSize: MAX_FIELD_BYTES,
          headerPairs: 20,
          fileSize: maxFileBytes + 1,
        },
      });
    } catch {
      reject(new UploadFormError('Send the document as a multipart form'));
      return;
    }

    const fields: Record<string, string> = {};
    let settled = false;
    // What the caller reads. It ends only when the whole form has been read and was as expected,
    // so a second file or a late field cannot follow a file that was already accepted.
    let handedOver: PassThrough | undefined;
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        request.unpipe(parser);
        reject(new UploadFormError(message));
      } else {
        handedOver?.destroy(new UploadFormError(message));
      }
    };

    parser.on('field', (name, value, info) => {
      if (settled || !fieldNames.includes(name) || info.valueTruncated || name in fields) {
        fail('Send only the title and category, before the file');
        return;
      }
      fields[name] = value;
    });
    parser.on('file', (name, file, info) => {
      if (settled || name !== 'file') {
        file.resume();
        fail('Send one file, in the field called file, after the other fields');
        return;
      }
      settled = true;
      const copy = new PassThrough();
      // It can be stopped before the caller starts reading it (the caller checks first on the database);
      // the error is kept on the stream (`errored`) for the caller, not lost as unhandled.
      copy.on('error', () => undefined);
      handedOver = copy;
      file.on('error', (error: Error) => copy.destroy(error));
      file.pipe(copy, { end: false });
      resolve({ fields, fileName: withoutFolders(info.filename), file: copy });
    });
    // Busboy reports these once a second file, or one field too many, arrives.
    for (const limit of ['filesLimit', 'fieldsLimit'] as const) {
      parser.on(limit, () => fail('The form has more parts than expected'));
    }
    parser.on('error', () => fail('The form could not be read'));
    parser.on('close', () => {
      if (handedOver) {
        handedOver.end();
      } else {
        fail('The form has no file');
      }
    });
    request.on('aborted', () => {
      if (settled) {
        handedOver?.destroy(new Error('The upload was interrupted'));
      } else {
        fail('The upload was interrupted');
      }
    });

    request.pipe(parser);
  });
}

/** Reads and drops the rest of a file that will not be kept. Errors are expected and ignored: nothing of it is used. */
export function discardUpload(file: Readable): void {
  file.on('error', () => undefined);
  file.resume();
}

/** Some browsers send the full path the file came from; only its last part is the name. */
function withoutFolders(fileName: string): string {
  return fileName.split(/[/\\]/).pop()?.trim() ?? '';
}
