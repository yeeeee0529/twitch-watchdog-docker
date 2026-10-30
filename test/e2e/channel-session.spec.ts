import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { evaluateChannelHealth } from '../../src/browser/ChannelSession.js';
import { collapseSideNav } from '../../src/browser/SideNavCollapser.js';

function mockPageUrl(fileName: string): string {
  return pathToFileURL(
    resolve(process.cwd(), 'test', 'mock-pages', fileName),
  ).href;
}

test.describe('ChannelSession mock pages', () => {
  test('展開的 Twitch 左側欄會自動收合', async ({ page }) => {
    await page.goto(mockPageUrl('side-nav.html'));

    await expect(collapseSideNav(page)).resolves.toBe('collapsed');
    await expect(
      page.locator('[data-a-target="side-nav-arrow"]'),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(collapseSideNav(page)).resolves.toBe(
      'already_collapsed',
    );
  });

  test('live 頁面判定 healthy', async ({ page }) => {
    const url = mockPageUrl('live.html');
    await page.goto(url);

    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
  });

  test('content-warning 頁面會確認後判定 healthy', async ({ page }) => {
    const url = mockPageUrl('content-warning.html');
    await page.goto(url);

    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: true,
      reason: 'live',
    });
    await expect(
      page.locator('[data-a-target="video-player"]'),
    ).toBeVisible();
  });

  test('login-required 頁面回報 login_required', async ({ page }) => {
    const url = mockPageUrl('login-required.html');
    await page.goto(url);

    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: false,
      reason: 'login_required',
    });
  });

  test('一般登入按鈕回報 login_missing，明確登入阻擋才回報 login_required', async ({ page }) => {
    const url = mockPageUrl('live.html');
    await page.goto(url);
    await page.setContent(`
      <button data-a-target="login-button">Log in</button>
      <div data-a-target="video-player">Live stream</div>
    `);
    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: false,
      reason: 'login_missing',
    });
    await page.locator('[data-a-target="video-player"]').evaluate((element) => {
      element.setAttribute('data-test-selector', 'login-required');
    });
    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: false,
      reason: 'login_required',
    });
  });

  test('隱藏登入按鈕不誤判，未登入也保留播放器錯誤與離線原因', async ({ page }) => {
    const url = mockPageUrl('live.html');
    await page.goto(url);
    await page.setContent(`
      <button data-a-target="login-button" style="display:none">Log in</button>
      <div data-a-target="video-player">Live stream</div>
    `);
    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({ healthy: true, reason: 'live' });
    await page.locator('button').evaluate((element) => element.removeAttribute('style'));
    await page.locator('div').evaluate((element) => element.setAttribute('data-channel-health', 'error'));
    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({ healthy: false, reason: 'error_page' });
    await page.locator('div').evaluate((element) => element.setAttribute('data-channel-health', 'offline'));
    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({ healthy: false, reason: 'offline' });
  });

  test('error 頁面回報 error_page', async ({ page }) => {
    const url = mockPageUrl('error.html');
    await page.goto(url);

    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: false,
      reason: 'error_page',
    });
  });

  test('offline 頁面回報 offline', async ({ page }) => {
    const url = mockPageUrl('offline.html');
    await page.goto(url);

    await expect(evaluateChannelHealth(page, url)).resolves.toEqual({
      healthy: false,
      reason: 'offline',
    });
  });
});
