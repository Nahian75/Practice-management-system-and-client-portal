import { expect, test } from './support/test';
import { apiTarget } from '../src/lib/api-target';

// No browser: these check the pass-through's address building directly.
test.describe('the /api pass-through', () => {
  test.beforeAll(() => {
    process.env['API_URL'] = 'http://127.0.0.1:3101';
  });

  test('sends a path to the API, with its query', () => {
    expect(apiTarget(new URL('http://localhost:3100/api/clients/search?q=smith')).href).toBe(
      'http://127.0.0.1:3101/clients/search?q=smith',
    );
  });

  for (const [description, path] of [
    ['a protocol-relative path', '/api//evil.example/steal'],
    ['an absolute address in the path', '/api/http://evil.example/steal'],
    ['a path climbing out', '/api/../../evil'],
  ]) {
    test(`never leaves the API for ${description}`, () => {
      const target = apiTarget(new URL(`http://localhost:3100${path}`));

      expect(target.origin).toBe('http://127.0.0.1:3101');
    });
  }
});
