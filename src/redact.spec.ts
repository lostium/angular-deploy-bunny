import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact.js';

describe('createRedactor', () => {
  it('redacts every literal occurrence, including regexp characters and overlapping secrets', () => {
    const redact = createRedactor(['a.b', 'a.b-long', 'a.b', '$key[1]']);
    expect(redact('a.b-long a.b axb $key[1] a.b')).toBe('[REDACTED] [REDACTED] axb [REDACTED] [REDACTED]');
  });

  it('does not process replacement text again', () => {
    expect(createRedactor(['secret', 'REDACTED'])('secret REDACTED')).toBe('[REDACTED] [REDACTED]');
  });

  it('ignores empty and absent values', () => {
    expect(createRedactor(['', null, undefined])('unchanged')).toBe('unchanged');
  });
});
