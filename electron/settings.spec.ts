import { describe, expect, it } from 'vitest';
import { nextZoom, restoreBounds } from './settings';

describe('nextZoom', () => {
  it('steps through the zoom levels and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(2, 1)).toBe(2);
    expect(nextZoom(0.67, -1)).toBe(0.67);
    expect(nextZoom(1.2, 1)).toBe(1.25);
  });
});

describe('restoreBounds', () => {
  const min = { width: 900, height: 600 };
  const laptop = { x: 0, y: 0, width: 1920, height: 1040 };
  const monitor = { x: 1920, y: 0, width: 2560, height: 1400 };

  it('opens where the window was', () => {
    const saved = { x: 100, y: 50, width: 1500, height: 900 };
    expect(restoreBounds(saved, [laptop], min)).toEqual(saved);
    const right = { x: 2000, y: 100, width: 2200, height: 1200 };
    expect(restoreBounds(right, [laptop, monitor], min)).toEqual(right);
  });

  it('falls back to the default without a saved place or when its screen is gone', () => {
    expect(restoreBounds(null, [laptop], min)).toBeNull();
    expect(restoreBounds({ x: 2000, y: 100, width: 1200, height: 800 }, [laptop], min)).toBeNull();
  });

  it('shrinks and moves a window that no longer fits its screen', () => {
    expect(restoreBounds({ x: 1800, y: 600, width: 2400, height: 1300 }, [laptop], min)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    });
    expect(restoreBounds({ x: -200, y: 20, width: 1000, height: 700 }, [laptop], min)).toEqual({
      x: 0,
      y: 20,
      width: 1000,
      height: 700,
    });
  });

  it('does not open with the title bar off screen', () => {
    expect(restoreBounds({ x: 100, y: -500, width: 1200, height: 800 }, [laptop], min)).toBeNull();
  });
});
