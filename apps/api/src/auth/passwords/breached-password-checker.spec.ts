import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreachedPasswordChecker } from './breached-password-checker.js';

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PASSWORD = 'password';
const PREFIX = '5BAA6';
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';
const OTHER_SUFFIX = '0018A45C4D1DEF81644B54AB7F969B88D65';

function fakeFetch(respond: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => respond());
}

describe('BreachedPasswordChecker', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends only the first five characters of the hash', async () => {
    const fetchFn = fakeFetch(() => new Response(`${OTHER_SUFFIX}:3\r\n`));

    await new BreachedPasswordChecker(fetchFn).check(PASSWORD);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
    expect(String(url)).not.toContain(SUFFIX);
    expect(JSON.stringify(init)).not.toContain(PASSWORD);
  });

  it('asks for padded responses', async () => {
    const fetchFn = fakeFetch(() => new Response(''));

    await new BreachedPasswordChecker(fetchFn).check(PASSWORD);

    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Add-Padding': 'true' });
  });

  it('reports a password that appears in a breach', async () => {
    const fetchFn = fakeFetch(() => new Response(`${OTHER_SUFFIX}:3\r\n${SUFFIX}:9545824\r\n`));

    expect(await new BreachedPasswordChecker(fetchFn).check(PASSWORD)).toBe('breached');
  });

  it('reports a password that does not appear', async () => {
    const fetchFn = fakeFetch(() => new Response(`${OTHER_SUFFIX}:3\r\n`));

    expect(await new BreachedPasswordChecker(fetchFn).check(PASSWORD)).toBe('not_breached');
  });

  it('ignores padding entries, which have a count of zero', async () => {
    const fetchFn = fakeFetch(() => new Response(`${SUFFIX}:0\r\n`));

    expect(await new BreachedPasswordChecker(fetchFn).check(PASSWORD)).toBe('not_breached');
  });

  it.each([
    ['the service returns an error', () => new Response('busy', { status: 503 })],
    ['the network fails', () => Promise.reject(new TypeError('fetch failed'))],
    ['the request times out', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('reports unavailable when %s', async (_case, respond) => {
    const fetchFn = fakeFetch(respond);

    expect(await new BreachedPasswordChecker(fetchFn).check(PASSWORD)).toBe('unavailable');
  });

  it('logs an outage without any password data', async () => {
    const distinctivePassword = 'zebra-lantern-quartz-91';
    // SHA-1 prefix of the distinctive password, which must not be logged either.
    const distinctivePrefix = '0D39E';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const fetchFn = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));

    await new BreachedPasswordChecker(fetchFn).check(distinctivePassword);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('unavailable');
    expect(logged).not.toContain(distinctivePassword);
    expect(logged).not.toContain(distinctivePrefix);
  });

  it('treats an unexpected response body as not listed rather than crashing', async () => {
    const fetchFn = fakeFetch(() => new Response('<html>maintenance</html>'));

    expect(await new BreachedPasswordChecker(fetchFn).check(PASSWORD)).toBe('not_breached');
  });
});
