import { generatePublicId } from './public-id.util';
import { PUBLIC_ID_LENGTH, PUBLIC_ID_PATTERN } from './videos.constants';

describe('generatePublicId', () => {
  it('should return exactly 11 characters', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('should only use base62 characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('should produce distinct values across many calls', () => {
    const ids = new Set(Array.from({ length: 5000 }, generatePublicId));

    expect(ids.size).toBe(5000);
  });

  it('should use the whole alphabet and not only part of it', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      for (const char of generatePublicId()) seen.add(char);
    }

    expect(seen.size).toBe(62);
  });
});
