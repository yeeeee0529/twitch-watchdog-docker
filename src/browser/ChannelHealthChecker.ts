import type { Locator, Page } from 'playwright';

import { isExpectedChannelUrl } from './channel-url.js';
import { safeErrorMessage } from './safe-logging.js';

const CONTENT_WARNING_SETTLE_TIMEOUT_MS = 3_000;

export const CHANNEL_HEALTH_SELECTORS = Object.freeze({
  loginRequired: [
    '[data-test-selector="login-required"]',
    '[data-channel-health="login-required"]',
  ].join(', '),
  loggedOut: '[data-a-target="login-button"]',
  liveContent: [
    '[data-a-target="video-player"]',
    '[data-test-selector="video-player"]',
    '[data-channel-health="live"]',
  ].join(', '),
  error: [
    '[data-test-selector="error-page"]',
    '[data-a-target="player-error-message"]',
    '[data-channel-health="error"]',
  ].join(', '),
  offline: [
    '[data-test-selector="offline-page"]',
    '[data-a-target="offline-channel-main-content"]',
    '[data-channel-health="offline"]',
  ].join(', '),
  contentWarning: [
    '[data-a-target="content-classification-gate-overlay-start-watching-button"]',
    '[data-a-target="content-warning-start-watching-button"]',
    '[data-channel-health="content-warning"]',
    'button:has-text("Start Watching")',
    'button:has-text("開始觀看")',
  ].join(', '),
});

export type ChannelHealthFailureReason =
  | 'not_started'
  | 'page_closed'
  | 'url_mismatch'
  | 'login_required'
  | 'login_missing'
  | 'error_page'
  | 'offline'
  | 'content_warning'
  | 'live_content_missing'
  | 'health_check_error';

export type ChannelHealthResult =
  | { readonly healthy: true; readonly reason: 'live' }
  | {
      readonly healthy: false;
      readonly reason: ChannelHealthFailureReason;
      readonly error?: string;
    };

export type ChannelHealthEvaluator = (
  page: Page,
  targetUrl: string,
) => Promise<ChannelHealthResult>;

export type ContentWarningAcceptResult =
  | 'not_present'
  | 'accepted'
  | 'blocked';

interface ChannelHealthSnapshot {
  readonly loginRequired: boolean;
  readonly loggedOut: boolean;
  readonly error: boolean;
  readonly offline: boolean;
  readonly liveContent: boolean;
  readonly unsupportedPlayerError: boolean;
}

export async function evaluateChannelHealth(
  page: Page,
  targetUrl: string,
): Promise<ChannelHealthResult> {
  try {
    if (page.isClosed()) {
      return { healthy: false, reason: 'page_closed' };
    }

    if (!isExpectedChannelUrl(page.url(), targetUrl)) {
      return { healthy: false, reason: 'url_mismatch' };
    }

    const snapshot = await readChannelHealthSnapshot(page);

    if (snapshot.loginRequired) {
      return { healthy: false, reason: 'login_required' };
    }

    if (snapshot.error || snapshot.unsupportedPlayerError) {
      return { healthy: false, reason: 'error_page' };
    }

    if (snapshot.offline) {
      return { healthy: false, reason: 'offline' };
    }

    const contentWarningResult = await acceptContentWarning(page);
    if (
      contentWarningResult === 'accepted' &&
      await isVisible(page.locator(CHANNEL_HEALTH_SELECTORS.liveContent))
    ) {
      return snapshot.loggedOut
        ? { healthy: false, reason: 'login_missing' }
        : { healthy: true, reason: 'live' };
    }
    if (contentWarningResult !== 'not_present') {
      return { healthy: false, reason: 'content_warning' };
    }

    if (snapshot.loggedOut) {
      return { healthy: false, reason: 'login_missing' };
    }

    if (snapshot.liveContent) {
      return { healthy: true, reason: 'live' };
    }

    return { healthy: false, reason: 'live_content_missing' };
  } catch (error: unknown) {
    return {
      healthy: false,
      reason: 'health_check_error',
      error: safeErrorMessage(error),
    };
  }
}

export async function acceptContentWarning(
  page: Page,
): Promise<ContentWarningAcceptResult> {
  const button = page.locator(CHANNEL_HEALTH_SELECTORS.contentWarning).first();
  if (!(await isVisible(button))) {
    return 'not_present';
  }

  try {
    await button.click({ timeout: CONTENT_WARNING_SETTLE_TIMEOUT_MS });
    await page
      .locator(CHANNEL_HEALTH_SELECTORS.liveContent)
      .first()
      .waitFor({
        state: 'visible',
        timeout: CONTENT_WARNING_SETTLE_TIMEOUT_MS,
      })
      .catch(() => undefined);
    return 'accepted';
  } catch {
    return 'blocked';
  }
}

async function isVisible(locator: Locator): Promise<boolean> {
  return locator.first().isVisible();
}

async function readChannelHealthSnapshot(
  page: Page,
): Promise<ChannelHealthSnapshot> {
  return page.evaluate((selectors) => {
    interface BrowserElement {
      readonly textContent: string | null;
      getBoundingClientRect(): { readonly width: number; readonly height: number };
      getClientRects(): { readonly length: number };
    }

    interface BrowserDocument {
      querySelectorAll(selector: string): Iterable<BrowserElement>;
    }

    interface BrowserGlobal {
      readonly document: BrowserDocument;
      getComputedStyle(element: BrowserElement): {
        readonly display: string;
        readonly visibility: string;
      };
    }

    const browserGlobal = globalThis as unknown as BrowserGlobal;
    const isElementVisible = (element: BrowserElement): boolean => {
      const style = browserGlobal.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }

      const bounds = element.getBoundingClientRect();
      return (
        (bounds.width > 0 && bounds.height > 0) ||
        element.getClientRects().length > 0
      );
    };
    const hasVisibleElement = (selector: string): boolean =>
      Array.from(browserGlobal.document.querySelectorAll(selector)).some(
        isElementVisible,
      );
    const playerText = Array.from(
      browserGlobal.document.querySelectorAll(selectors.playerErrorText),
    )
      .map((element) => element.textContent ?? '')
      .join(' ');

    return {
      loginRequired: hasVisibleElement(selectors.loginRequired),
      loggedOut: hasVisibleElement(selectors.loggedOut),
      error: hasVisibleElement(selectors.error),
      offline: hasVisibleElement(selectors.offline),
      liveContent: hasVisibleElement(selectors.liveContent),
      unsupportedPlayerError:
        /This video is either unavailable or not supported in this browser/iu
          .test(playerText) || /Error\s*#4000/iu.test(playerText),
    };
  }, {
    loginRequired: CHANNEL_HEALTH_SELECTORS.loginRequired,
    loggedOut: CHANNEL_HEALTH_SELECTORS.loggedOut,
    error: CHANNEL_HEALTH_SELECTORS.error,
    offline: CHANNEL_HEALTH_SELECTORS.offline,
    liveContent: CHANNEL_HEALTH_SELECTORS.liveContent,
    playerErrorText: [
      '[data-a-target="player-error-message"]',
      '[data-test-selector="video-player"]',
      '[data-a-target="video-player"]',
    ].join(', '),
  });
}
