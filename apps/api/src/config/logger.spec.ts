import { describe, expect, it } from 'vitest';
import { enabledLogLevels } from './logger.js';

describe('enabledLogLevels', () => {
  it('includes the threshold and everything more severe', () => {
    expect(enabledLogLevels('warn')).toEqual(['fatal', 'error', 'warn']);
  });

  it('includes every level at verbose', () => {
    expect(enabledLogLevels('verbose')).toHaveLength(6);
  });

  it('keeps only fatal at fatal', () => {
    expect(enabledLogLevels('fatal')).toEqual(['fatal']);
  });
});
