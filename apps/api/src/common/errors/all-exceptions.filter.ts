import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorBody {
  statusCode: number;
  message: string | string[];
  reference?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    if (response.headersSent) {
      return;
    }

    const statusCode = statusCodeOf(exception);
    const body: ErrorBody =
      statusCode >= HttpStatus.INTERNAL_SERVER_ERROR
        ? this.serverError(exception, statusCode, request)
        : { statusCode, message: clientMessageOf(exception, statusCode) };

    response.status(statusCode).json(body);
  }

  private serverError(exception: unknown, statusCode: number, request: Request): ErrorBody {
    const reference = randomUUID();
    const stack = exception instanceof Error ? exception.stack : String(exception);

    // request.path excludes the query string, which can carry tokens.
    this.logger.error(`${reference} ${request.method} ${request.path}`, stack);

    return { statusCode, message: reasonPhrase(statusCode), reference };
  }
}

function statusCodeOf(exception: unknown): number {
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  if (isExposableClientError(exception)) {
    return exception.status;
  }
  return HttpStatus.INTERNAL_SERVER_ERROR;
}

function clientMessageOf(exception: unknown, statusCode: number): string | string[] {
  // Preserve our public body-parser contract across framework patch versions.
  if (statusCode === HttpStatus.PAYLOAD_TOO_LARGE && exception instanceof HttpException && exception.message === 'request entity too large') {
    return reasonPhrase(statusCode);
  }
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    if (typeof response === 'string') {
      return response;
    }
    if ('message' in response && isMessage(response.message)) {
      return response.message;
    }
  }
  return reasonPhrase(statusCode);
}

/**
 * Errors from Express internals such as the body parser follow the
 * `http-errors` convention: a 4xx `status` plus `expose: true` when the
 * error is safe to report to the client.
 */
function isExposableClientError(value: unknown): value is { status: number } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { status, expose } = value as { status?: unknown; expose?: unknown };
  return (
    expose === true &&
    typeof status === 'number' &&
    status >= HttpStatus.BAD_REQUEST &&
    status < HttpStatus.INTERNAL_SERVER_ERROR
  );
}

function isMessage(value: unknown): value is string | string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function reasonPhrase(statusCode: number): string {
  return STATUS_CODES[statusCode] ?? 'Error';
}
