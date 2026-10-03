import { HttpException, HttpStatus } from '@nestjs/common';
import { ADDRESS_WINDOW_MS } from './sign-in-limits.js';

export const TOO_MANY_ATTEMPTS_MESSAGE = 'Too many failed attempts from your network. Try again later';

/** 429. The Retry-After header is set by the controller, which owns the response. */
export class TooManyAttemptsException extends HttpException {
  constructor() {
    super(TOO_MANY_ATTEMPTS_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export const RETRY_AFTER_SECONDS = String(ADDRESS_WINDOW_MS / 1000);
