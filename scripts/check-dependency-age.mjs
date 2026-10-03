import { readFileSync } from 'node:fs';

const MIN_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = 8;

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const lock = readJson('../package-lock.json');
const exceptions = readJson('../dependency-age-exceptions.json');
const now = Date.now();

// An expired exception must be removed, not left to excuse future versions.
const expired = exceptions.filter((exception) => Date.parse(exception.expires) <= now);
if (expired.length > 0) {
  console.error(
    `Expired dependency-age exceptions. Remove them from dependency-age-exceptions.json and .npmrc:\n  ${expired
      .map((exception) => `${exception.package}@${exception.version} (expired ${exception.expires})`)
      .join('\n  ')}`,
  );
  process.exit(1);
}

const excused = new Set(exceptions.map((exception) => `${exception.package}@${exception.version}`));

const installed = Object.entries(lock.packages)
  .filter(([path, entry]) => path.includes('node_modules/') && !entry.link)
  .map(([path, entry]) => ({ name: path.slice(path.lastIndexOf('node_modules/') + 13), version: entry.version }));

const unique = [...new Map(installed.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])).values()];

async function publishedAt({ name, version }) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${name}: registry returned ${response.status}`);
  }
  const metadata = await response.json();
  return metadata.time?.[version];
}

const tooNew = [];
for (let i = 0; i < unique.length; i += CONCURRENCY) {
  const batch = unique.slice(i, i + CONCURRENCY);
  const dates = await Promise.all(batch.map(publishedAt));
  batch.forEach((pkg, j) => {
    const ageDays = (now - Date.parse(dates[j])) / DAY_MS;
    if (!(ageDays >= MIN_AGE_DAYS) && !excused.has(`${pkg.name}@${pkg.version}`)) {
      tooNew.push(`${pkg.name}@${pkg.version} (${Number.isNaN(ageDays) ? 'unknown date' : `${ageDays.toFixed(1)} days`})`);
    }
  });
}

if (tooNew.length > 0) {
  console.error(`Packages younger than ${MIN_AGE_DAYS} days:\n  ${tooNew.join('\n  ')}`);
  process.exit(1);
}

const note = exceptions.length > 0 ? `, with ${exceptions.length} recorded exception(s)` : '';
console.log(`All ${unique.length} packages are at least ${MIN_AGE_DAYS} days old${note}.`);
