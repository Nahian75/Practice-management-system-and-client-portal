import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const SCAN_TIMEOUT_MS = 60_000;

export type ScanResult = { clean: true } | { clean: false; signature: string };

/** ClamAV's report for a file past its limits (AlertExceedsMax): not found to be malware, but not fully scanned either. */
export const isLimitsAlert = (signature: string) => signature.startsWith('Heuristics.Limits.Exceeded');

/** The scanner could not give an answer. Uploads fail closed: nothing unscanned is stored. */
export class ScannerUnavailableError extends Error {
  override readonly name = 'ScannerUnavailableError';
}

/**
 * Scans a file with ClamAV's daemon, streaming it with the INSTREAM command:
 * each piece is sent with its length, and a zero length ends the file. Only
 * "OK" is clean; any answer it does not recognise is treated as no answer.
 */
@Injectable()
export class VirusScanner {
  private readonly host: string;
  private readonly port: number;

  constructor(@Inject(ENV) env: Env) {
    this.host = env.CLAMAV_HOST;
    this.port = env.CLAMAV_PORT;
  }

  async scan(file: Readable): Promise<ScanResult> {
    const socket = connect({ host: this.host, port: this.port });
    socket.setTimeout(SCAN_TIMEOUT_MS);
    const reply = readReply(socket);
    // If connecting fails, this rejects before it is awaited below; marked handled so the process is not taken down.
    reply.catch(() => undefined);
    try {
      await opened(socket);
      await send(socket, Buffer.from('zINSTREAM\0', 'ascii'));
      for await (const piece of file as AsyncIterable<Buffer>) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(piece.length);
        await send(socket, Buffer.concat([length, piece]));
      }
      await send(socket, Buffer.alloc(4));
      return parse(await reply);
    } catch (error) {
      if (error instanceof ScannerUnavailableError) {
        throw error;
      }
      // The daemon closes the connection itself when a file is over its size limit.
      throw new ScannerUnavailableError(`The scanner gave no answer (${error instanceof Error ? error.name : 'unknown error'})`);
    } finally {
      socket.destroy();
    }
  }
}

function opened(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

function send(socket: Socket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/** Everything the daemon says, up to its closing null byte or the end of the connection. */
function readReply(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    socket.on('data', (data: Buffer) => {
      reply += data.toString('utf8');
      if (reply.includes('\0')) {
        resolve(reply);
      }
    });
    socket.once('end', () => resolve(reply));
    socket.once('timeout', () => reject(new ScannerUnavailableError('The scanner did not answer in time')));
    socket.once('error', reject);
  });
}

function parse(reply: string): ScanResult {
  const answer = reply.replaceAll('\0', '').trim();
  if (answer === 'stream: OK') {
    return { clean: true };
  }
  const found = /^stream: (.+) FOUND$/.exec(answer);
  if (found?.[1]) {
    return { clean: false, signature: found[1] };
  }
  throw new ScannerUnavailableError(`The scanner could not scan the file: ${answer.slice(0, 100)}`);
}
