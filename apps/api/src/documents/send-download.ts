import { pipeline } from 'node:stream/promises';
import { HttpStatus, type Logger } from '@nestjs/common';
import type { Response } from 'express';
import { attachmentDisposition } from './content-disposition.js';
import type { DownloadResult } from './documents.service.js';

export const DOCUMENT_NOT_FOUND_MESSAGE = 'No document with this id';
export const WITHDRAWN_MESSAGE = 'This document was withdrawn';

/**
 * Sends the file, decrypted as it goes, always as a download. If the stored
 * file fails its integrity check part-way, the connection is cut: the
 * browser sees an incomplete download, never altered content.
 */
export async function sendDownload(download: Extract<DownloadResult, { outcome: 'ready' }>, response: Response, logger: Logger, label: string): Promise<void> {
  response.status(HttpStatus.OK);
  response.setHeader('Content-Type', download.mediaType);
  response.setHeader('Content-Length', String(download.sizeBytes));
  response.setHeader('Content-Disposition', attachmentDisposition(download.fileName));
  // Should a browser ever show it anyway: no script, no requests, its own origin.
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  try {
    await pipeline(download.file, response);
  } catch (error) {
    // pipeline has already cut the connection: with Content-Length set, the browser sees a failed download.
    logger.error(`Download of ${label} stopped: ${error instanceof Error ? error.name : 'unknown error'}`);
  }
}
