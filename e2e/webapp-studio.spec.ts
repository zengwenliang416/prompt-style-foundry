import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * U05 acceptance against real data: detail + source display, hash
 * consistency between displayed body and catalog, sample prompt tab
 * (installed sidecars), copy/download paths.
 */

test('shows template detail, source attribution, and a passing hash badge', async ({ page }) => {
  await page.goto('/studio/case-1');

  await expect(page.locator('.studio__title')).toHaveText(/.+/);
  await expect(page.locator('.studio__id')).toHaveText('case-1');
  await expect(page.locator('.studio__source')).toContainText('作者署名');
  await expect(page.locator('.studio__source')).toContainText('MIT');

  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.studio__hash')).toHaveText('SHA-256 与目录一致 ✓', { timeout: 15_000 });
});

test('compiled prompt body matches the shipped TXT file', async ({ page }) => {
  await page.goto('/studio/case-1');
  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });

  const displayed = await page.locator('.studio__prompt-body').textContent();
  const shipped = readFileSync(path.resolve('public/data/prompts/case-1.txt'), 'utf8');
  expect(displayed).toBe(shipped);
});

test('sample prompt tab: honest empty state for case-1, real sidecar for framework-001', async ({
  page,
}) => {
  await page.goto('/studio/case-1');
  await page.getByRole('tab', { name: '示例实际提示词' }).click();
  await expect(page.locator('.studio__prompt-state')).toContainText('该模板没有已审阅的示例生成提示词');

  await page.goto('/studio/framework-001');
  await page.getByRole('tab', { name: '示例实际提示词' }).click();
  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });
  const sample = await page.locator('.studio__prompt-body').textContent();
  const sidecar = readFileSync(
    path.resolve('public/data/generated-previews/framework-001.prompt.txt'),
    'utf8',
  );
  expect(sample).toBe(sidecar);
});

test('download delivers the exact displayed body as {id}.txt', async ({ page }) => {
  await page.goto('/studio/case-1');
  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });
  const displayed = (await page.locator('.studio__prompt-body').textContent()) ?? '';

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 .txt' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('case-1.txt');

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  expect(Buffer.concat(chunks).toString('utf8')).toBe(displayed);
});

test('single-image input: preview, remove, and multi-file rejection', async ({ page }) => {
  await page.goto('/studio/case-1');
  const input = page.locator('.studio__dropzone input[type="file"]');

  // Tiny valid PNG (1x1 transparent).
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000148afa4710000000049454e44ae426082',
    'hex',
  );
  await input.setInputFiles([
    { name: 'input.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.locator('.studio__input-img')).toBeVisible();
  await expect(page.locator('.studio__input-name')).toHaveText('input.png');

  await page.getByRole('button', { name: '移除图片' }).click();
  await expect(page.locator('.studio__dropzone')).toBeVisible();

  // The file picker cannot deliver two files (no `multiple` attribute); the
  // multi-file path is the drag-drop one, simulated via DataTransfer.
  const pngBase64 = png.toString('base64');
  await page.evaluate((b64) => {
    const target = document.querySelector<HTMLInputElement>(
      '.studio__dropzone input[type="file"]',
    );
    if (target === null) {
      throw new Error('input not found');
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'a.png', { type: 'image/png' }));
    transfer.items.add(new File([bytes], 'b.png', { type: 'image/png' }));
    target.files = transfer.files;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }, pngBase64);
  await expect(page.locator('.studio__input-error')).toContainText('单图协议');
});

test('input validation: unsupported type is rejected with explicit message', async ({ page }) => {
  await page.goto('/studio/case-1');
  const input = page.locator('.studio__dropzone input[type="file"]');

  await input.setInputFiles([
    { name: 'page.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') },
  ]);
  await expect(page.locator('.studio__input-error')).toContainText('仅支持 JPEG / PNG / WebP');
});

test('favorite a template; it appears in the workspace local favorites', async ({ page }) => {
  await page.goto('/studio/case-1');
  await page.getByRole('button', { name: /收藏/ }).first().click();
  await expect(page.locator('.toast').first()).toContainText('已加入本地收藏');

  await page.goto('/workspace');
  await expect(page.locator('.workspace__grid a[href="/studio/case-1"]')).toBeVisible();
  await expect(page.locator('.workspace__title').first()).toContainText('本地收藏（1）');
});

test('workspace import: bad JSON gives explicit feedback and keeps data', async ({ page }) => {
  await page.goto('/studio/case-1');
  await page.getByRole('button', { name: /收藏/ }).first().click();
  await page.waitForTimeout(200);

  await page.goto('/workspace');
  await page.setInputFiles('.workspace__import-input', {
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{broken json'),
  });
  await expect(page.locator('.toast').first()).toContainText('不是有效 JSON');
  await expect(page.locator('.workspace__grid a[href="/studio/case-1"]')).toBeVisible();
});

test('workspace export downloads a record JSON without the BYOK key', async ({ page }) => {
  await page.goto('/studio/case-1');
  await page.getByRole('button', { name: /收藏/ }).first().click();
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    localStorage.setItem('onepic.byok.key.v1', JSON.stringify('sk-e2e-export-check'));
  });

  await page.goto('/workspace');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出本地记录' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const content = Buffer.concat(chunks).toString('utf8');
  const exported = JSON.parse(content) as { schemaVersion: number; favorites: string[] };
  expect(exported.schemaVersion).toBe(1);
  expect(exported.favorites).toContain('case-1');
  expect(content).not.toContain('sk-e2e-export-check');
});

test('settings: mode switch persists, key stays local, no migration notice', async ({ page }) => {
  await page.goto('/studio/case-1');
  await page.getByRole('button', { name: '配置接口与隐私' }).click();

  const dialog = page.locator('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('input[name="run-mode"]')).toHaveCount(3);
  await expect(dialog).toContainText('暂未开放');

  await dialog.locator('input[value="direct-byok"]').check();
  await expect(dialog).toContainText('切换模式不会上传本机密钥或图片');

  await dialog.getByLabel('接口地址').fill('https://api.example.com/v1');
  await dialog.getByLabel('API 密钥（仅保存在本机浏览器）').fill('sk-e2e-test-key');
  await dialog.getByRole('button', { name: '保存设置' }).click();
  await expect(dialog).toContainText('设置已保存到本机浏览器。');

  // The settings record never contains the key; the dedicated slot does.
  const settingsRecord = await page.evaluate(() =>
    localStorage.getItem('onepic.settings.v1'),
  );
  expect(settingsRecord).not.toContain('sk-e2e-test-key');
  const keyRecord = await page.evaluate(() =>
    localStorage.getItem('onepic.byok.key.v1'),
  );
  expect(keyRecord).toContain('sk-e2e-test-key');

  // Reload: settings restored, mode switch still performs no migration.
  await page.reload();
  await page.getByRole('button', { name: '配置接口与隐私' }).click();
  await expect(dialog.locator('input[value="direct-byok"]')).toBeChecked();
  const keyAfterReload = await page.evaluate(() =>
    localStorage.getItem('onepic.byok.key.v1'),
  );
  expect(keyAfterReload).toContain('sk-e2e-test-key');
  await expect(dialog).toContainText('它不会随模式切换上传、迁移或同步');

  await page.keyboard.press('Escape');
});

test('copy denial still gives visible feedback (headless clipboard is unavailable)', async ({
  page,
}) => {
  await page.goto('/studio/case-1');
  await expect(page.locator('.studio__prompt-body')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: '复制提示词' }).click();
  // Headless Chromium has no clipboard permission granted: either the success
  // toast (permission granted path) or the explicit denial toast must appear;
  // silence is the failure mode U05 forbids.
  await expect(page.locator('.toast').first()).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.toast')).not.toHaveCount(0);
});
