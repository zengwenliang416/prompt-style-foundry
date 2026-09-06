import { expect, test } from '@playwright/test';

/**
 * U02 acceptance: deep links survive refresh, back/forward works, narrow
 * screens keep the top-bar navigation usable, and unknown routes show 404.
 * The shell renders two nav landmarks with the same label (sidebar + top
 * bar, one hidden per breakpoint); tests scope to the visible container.
 */

test('deep link to a page survives refresh (history fallback)', async ({ page }) => {
  await page.goto('/guide');
  await expect(page.locator('#main-content h1')).toHaveText(/图片决定内容/);

  await page.reload();
  await expect(page.locator('#main-content h1')).toHaveText(/图片决定内容/);
});

test('client-side navigation works with back/forward', async ({ page }) => {
  await page.goto('/');

  const sidebarNav = page.locator('.shell__sidebar nav');
  await sidebarNav.getByText('模板发现').click();
  await expect(page.locator('#main-content h1')).toHaveText(/为你的图片/);

  await sidebarNav.getByText('使用指南').click();
  await expect(page.locator('#main-content h1')).toHaveText(/图片决定内容/);

  await page.goBack();
  await expect(page.locator('#main-content h1')).toHaveText(/为你的图片/);

  await page.goForward();
  await expect(page.locator('#main-content h1')).toHaveText(/图片决定内容/);
});

test('exact nav highlight: aria-current follows the active route', async ({ page }) => {
  await page.goto('/guide');
  const sidebarNav = page.locator('.shell__sidebar nav');
  await expect(sidebarNav.getByText('使用指南')).toHaveAttribute('aria-current', 'page');
  await expect(sidebarNav.getByText('总览')).not.toHaveAttribute('aria-current', 'page');
});

test('top-bar navigation remains usable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/');

  const topNav = page.locator('.shell__nav--top');
  await topNav.getByText('使用指南').click();
  await expect(page.locator('#main-content h1')).toHaveText(/图片决定内容/);
});

test('guide page content matches protocol and modes', async ({ page }) => {
  await page.goto('/guide');
  const body = await page.locator('#main-content').textContent();
  expect(body).toContain('图片决定内容，蓝图决定风格');
  expect(body).toContain('Nano Banana Pro');
  expect(body).toContain('未开放');
  expect(body).not.toContain('禁止直接图生图');
  expect(body).not.toContain('零中转');
});

test('unknown route shows the 404 page with a way home', async ({ page }) => {
  await page.goto('/definitely/missing');
  await expect(page.locator('#main-content')).toContainText('404');

  await page.getByText('返回总览').click();
  await expect(page.locator('#main-content h1')).toHaveText(/一张图，开启更多视觉可能/);
});
