import { expect, test } from '@playwright/test';

/**
 * U12 responsive + accessibility regression across the five pages:
 * 320/768/1440 widths, no horizontal overflow (covers long real titles and
 * ~200% zoom approximation), reduced-motion degradation, and the keyboard
 * path (skip link, focus-visible). Screenshots for the DESIGN.md baseline
 * comparison are saved under docs/design/evidence/u12/.
 */

const PAGES = [
  { path: '/', name: 'home' },
  { path: '/discover', name: 'discover' },
  { path: '/studio/case-1', name: 'studio' },
  { path: '/workspace', name: 'workspace' },
  { path: '/guide', name: 'guide' },
];
const WIDTHS = [320, 768, 1440];

for (const width of WIDTHS) {
  for (const entry of PAGES) {
    test(`${entry.path} renders without horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(entry.path);
      await expect(page.locator('#main-content')).toBeVisible();

      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth - document.documentElement.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);

      await page.screenshot({
        path: `docs/design/evidence/u12/${entry.name}-${width}.png`,
        fullPage: true,
      });
    });
  }
}

test('reduced-motion preference disables animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const reduced = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.animation = 'spin 1s linear infinite';
    document.body.append(probe);
    const duration = getComputedStyle(probe).animationDuration;
    probe.remove();
    return duration;
  });
  // Chromium serializes 0.01ms as 1e-05s in computed styles.
  expect(['1e-05s', '0.01ms']).toContain(reduced);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const normal = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.animation = 'spin 1s linear infinite';
    document.body.append(probe);
    const duration = getComputedStyle(probe).animationDuration;
    probe.remove();
    return duration;
  });
  expect(normal).toBe('1s');
});

test('keyboard path: skip link and visible focus ring', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');

  await page.keyboard.press('Tab');
  await expect(page.locator('a[href="#main-content"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id ?? ''), { timeout: 5_000 })
    .toBe('main-content');

  // Reach a nav link with bounded Tab presses, then verify the visible
  // focus ring (:focus-visible applies for keyboard-origin focus).
  const navLink = page.locator('.shell__sidebar .shell__nav-link').first();
  await expect
    .poll(
      async () => {
        for (let i = 0; i < 12; i += 1) {
          if (await navLink.evaluate((el) => el.matches(':focus-visible'))) {
            return true;
          }
          await page.keyboard.press('Tab');
        }
        return false;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  const outline = await navLink.evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).toBe('solid');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
});

test('longest real title causes no overflow on discover at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const response = await page.request.get('/data/catalog.json');
  const catalog = (await response.json()) as {
    templates: Array<{ id: string; title: string }>;
  };
  const longest = [...catalog.templates].sort(
    (a, b) => b.title.length - a.title.length,
  )[0];

  await page.goto(`/discover?q=${encodeURIComponent(longest!.id)}`);
  await expect(page.locator('.discover__card').first()).toBeVisible();
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});
