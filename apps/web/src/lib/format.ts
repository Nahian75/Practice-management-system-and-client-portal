/**
 * How dates, countries and client types are shown: British English, dates as
 * "5 October 2026", times in UK time.
 */

const LONG_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const COUNTRY_NAMES = new Intl.DisplayNames(['en-GB'], { type: 'region' });

/** An instant (when something happened), as a date in UK time. */
export function formatDate(iso: string): string {
  return LONG_DATE.format(new Date(iso));
}

/**
 * A calendar date such as a date of birth ("1980-02-29"). Read as the date it
 * is, never through a time zone, so it cannot shift by a day.
 */
export function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)),
  );
}

export function countryName(code: string): string {
  return COUNTRY_NAMES.of(code) ?? code;
}

export const CLIENT_KIND_LABELS = { individual: 'Individual', organisation: 'Organisation' } as const;

export const ORGANISATION_TYPE_LABELS = {
  company: 'Company',
  llp: 'Limited liability partnership',
  partnership: 'Partnership',
  charity: 'Charity',
  trust: 'Trust',
  other: 'Other',
} as const;
