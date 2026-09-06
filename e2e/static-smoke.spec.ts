import { expect, test } from '@playwright/test';

/**
 * Browser facility smoke (F04): the static catalog site is served by
 * scripts/serve.py and rendered in a real Chromium. U-phase E2E suites will
 * expand on the five pages against explicit test doubles.
 */

test('static catalog home renders in a real browser', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/OnePic Template Studio/);
  await expect(page.locator('#hero-title')).toBeVisible();
  await expect(page.locator('#template-library')).toBeVisible();

  // The catalog total is filled client-side after fetching data/catalog.json.
  await expect(page.locator('#metric-total')).toHaveText(/\d{3,}/, { timeout: 15_000 });
});
