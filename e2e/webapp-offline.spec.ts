import { expect, test } from '@playwright/test';

/**
 * W05 acceptance: static independence and mode honesty.
 *
 * - With every /api/* request aborted (server down), catalog-only browsing
 *   works end to end on all five pages, including prompt copy feedback —
 *   the catalog ships as static JSON and never depends on the API.
 * - Switching run modes shows an honest destination notice, persists the
 *   choice, and never migrates keys or silently switches providers: a failed
 *   managed run leaves runMode exactly where the user put it.
 */

test.beforeEach(async ({ page }) => {
  // Hard offline for any first-party API call.
  await page.route('**/api/**', (route) => route.abort());
});

test('API down: all five pages stay usable and prompt copy still gives feedback', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#main-content h1')).toHaveText(/一张图/);
  await expect(page.locator('.home__stat-value').first()).toBeVisible();

  await page.goto('/discover');
  await expect(page.locator('#main-content h1')).toHaveText(/为你的图片/);
  await expect(page.locator('.discover__grid .discover__card').first()).toBeVisible();

  await page.goto('/studio/case-1');
  await expect(page.locator('.studio__title')).toBeVisible();
  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '复制提示词' }).click();
  // Headless clipboard may be denied; either way the feedback is explicit.
  await expect(page.locator('.toast').first()).toBeVisible({ timeout: 5_000 });

  await page.goto('/workspace');
  await expect(page.locator('.workspace__header h1')).toHaveText('我的工作区');

  await page.goto('/guide');
  await expect(page.locator('#main-content h1')).toBeVisible();

  // Generate stays honestly disabled in catalog-only (default mode).
  await page.goto('/studio/case-1');
  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '生成图片' })).toBeDisabled();
});

test('mode switch shows where data goes; a failed managed run never auto-switches modes', async ({
  page,
}) => {
  await page.goto('/studio/case-1');
  await page.getByRole('button', { name: '配置接口与隐私' }).click();
  const dialog = page.locator('dialog');
  await expect(dialog).toBeVisible();

  await dialog.locator('input[value="direct-byok"]').check();
  await expect(page.locator('.toast').first()).toContainText('已切换到 BYOK 直连');
  await expect(page.locator('.toast').first()).toContainText('只发往你配置的接口');
  let record = JSON.parse(
    (await page.evaluate(() => localStorage.getItem('onepic.settings.v1'))) ?? '{}',
  ) as { runMode?: string };
  expect(record.runMode).toBe('direct-byok');

  await dialog.locator('input[value="managed-generation"]').check();
  await expect(page.locator('.toast').last()).toContainText('已切换到受管生成');
  await expect(page.locator('.toast').last()).toContainText('BYOK 密钥不会被使用');
  await page.keyboard.press('Escape');
  await expect(page.locator('.studio__bar-mode')).toContainText('受管生成');

  // Managed run with the API down: upload fails, the error is shown in
  // place, and the run mode is NOT auto-switched (no silent fallback).
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
    'hex',
  );
  await page.locator('.studio__dropzone input[type="file"]').setInputFiles([
    { name: 'input.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.getByRole('button', { name: '生成图片' }).click();
  await expect(page.locator('.studio__run-error')).toBeVisible({ timeout: 10_000 });

  record = JSON.parse(
    (await page.evaluate(() => localStorage.getItem('onepic.settings.v1'))) ?? '{}',
  ) as { runMode?: string };
  expect(record.runMode).toBe('managed-generation');
  await expect(page.locator('.studio__bar-mode')).toContainText('受管生成');
});
