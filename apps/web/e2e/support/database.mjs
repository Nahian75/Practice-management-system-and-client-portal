/**
 * The end-to-end database's address: the API test database's address from
 * apps/api/.env, with the same roles and passwords, but naming pms_e2e.
 * @param {string} testDatabaseUrl
 */
export function e2eDatabaseUrl(testDatabaseUrl) {
  const url = new URL(testDatabaseUrl);
  url.pathname = '/pms_e2e';
  return url.href;
}
