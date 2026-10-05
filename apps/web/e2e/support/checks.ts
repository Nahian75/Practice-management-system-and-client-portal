import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

export async function noAxeViolations(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
}

/** A short random string, so names made by different tests never meet. */
export const unique = () => randomUUID().replaceAll('-', '').slice(0, 10);

/**
 * Collects every Content Security Policy violation on the pages the test
 * visits. Only full page loads apply the policy to server-sent markup, so a
 * test reloads the pages it wants checked.
 */
export async function watchForCspViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('reportCspViolation', (directive: string) => violations.push(directive));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { reportCspViolation: (directive: string) => void }).reportCspViolation(event.violatedDirective);
    });
  });
  return violations;
}

/**
 * A name unlike any other test's, for conflict checks: their matching is
 * fuzzy, so names sharing a word ("Pat Client1", "Pat Client2") match.
 */
export function randomName(length = 12): string {
  const letters = Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
  return letters[0]!.toUpperCase() + letters.slice(1);
}
