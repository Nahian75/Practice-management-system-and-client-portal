import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { expect, test } from './support/test';
import packageJson from '../package.json' with { type: 'json' };

const PORT = 3100;

/** Whether a connection to this address and port is accepted. */
function accepts(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port: PORT, timeout: 2_000 });
    const finish = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

// Review W1: the web app passes the browser's X-Forwarded-For to the API, so it
// must be reached only through the reverse proxy on the same machine.
test('the web app accepts connections from this machine only', async () => {
  const outward = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address !== undefined && !address.internal && !address.address.startsWith('fe80'))
    .map((address) => address!.address);
  test.skip(outward.length === 0, 'This machine has no network address other than loopback');

  expect(await accepts('127.0.0.1')).toBe(true);
  for (const address of outward) {
    expect(await accepts(address), address).toBe(false);
  }
});

test('the start and development scripts listen on 127.0.0.1', () => {
  expect(packageJson.scripts.start).toContain('--hostname 127.0.0.1');
  expect(packageJson.scripts.dev).toContain('--hostname 127.0.0.1');
});
