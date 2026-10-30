import { connect, type Socket } from 'node:net';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const SCAN_TIMEOUT_MS = 60_000;
export const MAX_SIGNATURE_AGE_MS = 48 * 60 * 60_000;
const STATUS_TIMEOUT_MS = 3_000;
const STATUS_CACHE_MS = 30_000;

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
  private freshUntil = 0;

  constructor(@Inject(ENV) env: Env) {
    this.host = env.CLAMAV_HOST;
    this.port = env.CLAMAV_PORT;
  }

  async scan(file: Readable): Promise<ScanResult> {
    await this.assertAvailable();
    const socket = connect({ host: this.host, port: this.port });
    socket.setTimeout(SCAN_TIMEOUT_MS,()=>socket.destroy(new ScannerUnavailableError('Scanner timeout')));
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

  async assertAvailable(): Promise<void> {
    if (Date.now() < this.freshUntil) return;
    await checkScannerFreshness(this.host,this.port);
    this.freshUntil = Date.now()+STATUS_CACHE_MS;
  }
}

export function validateScannerVersion(reply: string, now = Date.now()): void {
  const match = /^ClamAV [^/\r\n]+\/\d+\/(.+)$/.exec(reply.replaceAll('\0','').trim());
  const timestamp = match ? Date.parse(match[1]!.trim()+' UTC') : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now+5*60_000 || now-timestamp > MAX_SIGNATURE_AGE_MS) {
    throw new ScannerUnavailableError('Antivirus definitions are stale or their age cannot be verified');
  }
}

/** Daemons are configured with TZ=UTC so VERSION timestamps are unambiguous. */
export async function checkScannerFreshness(host: string, port: number): Promise<void> {
  const socket = connect({host,port});
  socket.setTimeout(STATUS_TIMEOUT_MS,()=>socket.destroy(new ScannerUnavailableError('Scanner status timeout')));
  const reply = readReply(socket);
  reply.catch(()=>undefined);
  try {
    await opened(socket);
    await send(socket,Buffer.from('zVERSION\0','ascii'));
    validateScannerVersion(await reply);
  } catch (error) {
    if (error instanceof ScannerUnavailableError) throw error;
    throw new ScannerUnavailableError('Antivirus status cannot be verified');
  } finally { socket.destroy(); }
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
      if (reply.length > 4096) { socket.destroy(); reject(new ScannerUnavailableError('Scanner response exceeds the limit')); return; }
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
