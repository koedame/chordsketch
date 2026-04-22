import { describe, expect, test } from 'vitest';

import { version } from '../src/index';

describe('@chordsketch/react package scaffold', () => {
  test('version() returns a non-empty semver string', () => {
    const v = version();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
    // Matches any valid semver MAJOR.MINOR.PATCH(-prerelease)?(+build)?
    // The version at scaffold time is "0.0.0"; keep the matcher
    // permissive so this test does not require updating for every
    // bump.
    expect(v).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });
});
