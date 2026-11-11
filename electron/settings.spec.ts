import { describe, expect, it } from 'vitest';
import { nextZoom } from './settings';

describe('nextZoom', () => {
  it('steps through the zoom levels and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(2, 1)).toBe(2);
    expect(nextZoom(0.67, -1)).toBe(0.67);
    expect(nextZoom(1.2, 1)).toBe(1.25);
  });
});
