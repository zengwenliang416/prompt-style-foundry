import { expect, test } from '@playwright/test';

/**
 * U04 acceptance against the real generated catalog (public/data served
 * same-origin by vite preview): combined filters, URL recovery, clearing,
 * and the no-results state. Blueprint type is shown as a catalog property.
 */

test('discover page loads the real catalog incrementally', async ({ page }) => {
  await page.goto('/discover');

  await expect(page.locator('.discover__grid .discover__card').first()).toBeVisible();
  const count = await page.locator('.discover__count').textContent();
  expect(count).toContain('共 576 个模板');

  // Incremental rendering: fewer cards than the catalog total initially.
  const initialCards = await page.locator('.discover__card').count();
  expect(initialCards).toBe(24);

  await page.getByRole('button', { name: /加载更多/ }).click();
  await expect(page.locator('.discover__card')).toHaveCount(48);
});

test('search narrows results and writes the query into the URL', async ({ page }) => {
  await page.goto('/discover');

  await page.getByLabel('搜索模板（标题、风格、场景或编号）').fill('case-532');
  await expect(page).toHaveURL(/q=case-532/);
  await expect(page.locator('.discover__card')).toHaveCount(1);
  await expect(page.locator('.discover__card-id')).toHaveText('case-532');
});

test('URL query restores a filtered view after refresh', async ({ page }) => {
  await page.goto('/discover?mode=image-to-image');

  await expect(page).toHaveURL(/mode=image-to-image/);
  const count = await page.locator('.discover__count').textContent();
  expect(count).toContain('83 个模板');
  const badges = page.locator('.discover__card-badge--image-to-image');
  expect(await badges.count()).toBeGreaterThan(0);
});

test('combined filters, no-results state, and clearing', async ({ page }) => {
  await page.goto('/discover?mode=text-to-image');
  await page.getByLabel('搜索模板（标题、风格、场景或编号）').fill('case-532');

  // case-532 is text-to-image, so this combination matches exactly one.
  await expect(page.locator('.discover__card')).toHaveCount(1);

  // A combination with no matches offers a clear action.
  await page.getByLabel('搜索模板（标题、风格、场景或编号）').fill('zzz-不存在的模板');
  await expect(page.locator('.discover__state')).toContainText('没有符合条件的结果');
  await page.getByRole('button', { name: '清空筛选' }).click();

  await expect(page).toHaveURL((url) => !url.searchParams.has('q'));
  await expect(page.locator('.discover__card').first()).toBeVisible();
});
