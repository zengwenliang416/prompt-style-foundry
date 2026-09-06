import { expect, test } from '@playwright/test';

/**
 * U06 acceptance on real data: the overview shows the catalog's true
 * statistics, an honest local-mode service line (no fabricated online or
 * task counters), and an empty recent state on first visit.
 */

test('overview shows real catalog statistics and honest service line', async ({ page }) => {
  await page.goto('/');

  const values = page.locator('.home__stat-value');
  await expect(values.nth(0)).toHaveText('576');
  await expect(values.nth(1)).toHaveText('493');
  await expect(values.nth(2)).toHaveText('83');
  await expect(values.nth(3)).toHaveText('0');

  await expect(page.locator('.home__service-line')).toContainText('本地模式：未连接生成服务');
  const body = await page.locator('#main-content').textContent();
  expect(body).not.toContain('在线');
  expect(body).not.toContain('任务数');
});

test('recent views start empty and populate after visiting a template', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#main-content')).toContainText('暂无最近查看的模板');

  await page.goto('/studio/case-1');
  await expect(page.locator('.studio__title')).toBeVisible();

  await page.goto('/');
  await expect(page.locator('.home__recent-link').first()).toBeVisible();
  await expect(page.locator('.home__recent-id').first()).toHaveText('case-1');
});
