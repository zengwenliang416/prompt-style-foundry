// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrast checks for the DESIGN.md §2 token pairs actually used for text
 * and UI states (WCAG AA: ≥ 4.5:1 normal text, ≥ 3:1 large text / UI edges).
 * Values are parsed from tokens.css so the test fails when a token changes
 * without re-checking accessibility.
 */

const tokensCss = readFileSync(path.resolve('apps/web/src/app/styles/tokens.css'), 'utf8');

function token(name: string): string {
  const match = tokensCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (match === null) {
    throw new Error(`token --${name} not found in tokens.css`);
  }
  return match[1]!;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: string, background: string): number {
  const l1 = luminance(foreground);
  const l2 = luminance(background);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

describe('design token contrast (WCAG AA)', () => {
  const cases: Array<[string, string, string, number]> = [
    ['ink on bg (body text)', token('color-ink'), token('color-bg'), 4.5],
    ['ink on surface (card text)', token('color-ink'), token('color-surface'), 4.5],
    [
      'ink-secondary on surface (secondary text)',
      token('color-ink-secondary'),
      token('color-surface'),
      4.5,
    ],
    ['ink-secondary on bg (secondary text)', token('color-ink-secondary'), token('color-bg'), 4.5],
    [
      'teal on surface (links/active text)',
      token('color-accent-teal'),
      token('color-surface'),
      4.5,
    ],
    [
      'white on teal (primary button label)',
      token('color-on-teal'),
      token('color-accent-teal'),
      4.5,
    ],
    ['white on danger (danger button label)', token('color-on-danger'), token('color-danger'), 4.5],
    ['ink on amber (amber badge label)', token('color-on-amber'), token('color-accent-amber'), 4.5],
    ['teal vs line (UI edge distinguishable)', token('color-accent-teal'), token('color-line'), 3],
  ];

  for (const [label, fg, bg, min] of cases) {
    it(`meets ${min}:1 — ${label}`, () => {
      const ratio = contrast(fg, bg);
      expect(ratio).toBeGreaterThanOrEqual(min);
    });
  }

  it('keeps reduced-motion degradation in tokens.css', () => {
    expect(tokensCss).toContain('prefers-reduced-motion');
  });

  it('loads no external font (AGENTS §7)', () => {
    expect(tokensCss).not.toMatch(/url\(|@import|@font-face/);
  });
});
