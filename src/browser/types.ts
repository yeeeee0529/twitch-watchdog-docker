import type { Page } from 'playwright';

import type { AppConfig } from '../config/AppConfig.js';
import type { Logger } from '../logging/Logger.js';

export type BrowserManagerConfig = Pick<
  AppConfig,
  'headless' | 'storageStatePath'
> & {
  readonly browser: Pick<
    AppConfig['browser'],
    | 'restartOnCrash'
    | 'viewportWidth'
    | 'viewportHeight'
    | 'blockImages'
    | 'blockFonts'
    | 'blockKnownTracking'
    | 'disableChat'
    | 'recovery'
  >;
};

export interface BrowserLaunchOptions {
  readonly headless: boolean;
}

export interface BrowserContextOptions {
  readonly storageState: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
}

export interface BrowserPageAdapter {
  readonly page: Page;
  close(): Promise<void>;
  isClosed(): boolean;
  onCrash(listener: () => void): () => void;
  onClose(listener: () => void): () => void;
  onPopup(listener: (popup: Page) => void): () => void;
  onRequestFailed(
    listener: (diagnostic: BrowserRequestFailureDiagnostic) => void,
  ): () => void;
  onResponse(
    listener: (diagnostic: BrowserHttpResponseDiagnostic) => void,
  ): () => void;
  onConsole(
    listener: (diagnostic: BrowserConsoleDiagnostic) => void,
  ): () => void;
}

/** Sanitized Playwright `requestfailed` diagnostic. URL carries no query, fragment, or credentials. */
export interface BrowserRequestFailureDiagnostic {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly failureText?: string;
  readonly graphQlOperationNames?: readonly string[];
}

/** Sanitized Playwright `response` diagnostic for non-success or bootstrap-relevant responses. */
export interface BrowserHttpResponseDiagnostic {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly status: number;
  readonly statusText: string;
  readonly graphQlOperationNames?: readonly string[];
}

/** Sanitized Playwright `console` diagnostic. Arguments are never serialized. */
export interface BrowserConsoleDiagnostic {
  readonly type: string;
  readonly text: string;
  readonly sourceUrl?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

export interface BrowserContextAdapter {
  configureResourceBlocking(options: ResourceBlockingOptions): Promise<void>;
  configureChatBlocking(enabled: boolean): Promise<void>;
  newPage(): Promise<BrowserPageAdapter>;
  close(): Promise<void>;
}

export interface ResourceBlockingOptions {
  readonly blockImages: boolean;
  readonly blockFonts: boolean;
  readonly blockKnownTracking: boolean;
}

export interface BrowserAdapter {
  newContext(options: BrowserContextOptions): Promise<BrowserContextAdapter>;
  close(): Promise<void>;
  onDisconnected(listener: () => void): () => void;
  /** Whether the Playwright connection to the browser process is still alive. */
  isConnected(): boolean;
  /** Safe browser build/version string reported by Playwright. */
  getVersion(): string;
}

/** Result of a timed resource close attempt. Timeout is never success. */
export type CloseOutcome =
  | { readonly status: 'closed' }
  | { readonly status: 'already_closed' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'timed_out' };

export interface BrowserTeardownResult {
  readonly browserTerminated: boolean;
  readonly pageCloseTimedOut: boolean;
  readonly browserCloseTimedOut: boolean;
  readonly browserCloseFailed: boolean;
}

export interface BrowserLauncher {
  launch(options: BrowserLaunchOptions): Promise<BrowserAdapter>;
}

export interface BrowserManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  createPage(channel: string): Promise<Page>;
  closePage(channel: string): Promise<void>;
  restart(): Promise<void>;
  getPageCount(): number;
  getBrowserGeneration(): number;
  getBrowserVersion(): string | null;
}

export type BrowserNavigationOutcome =
  | {
      readonly channel: string;
      readonly status: 'succeeded';
    }
  | {
      readonly channel: string;
      readonly status: 'timed_out';
    };

export type BrowserInvalidationReason =
  | 'page_crashed'
  | 'page_closed'
  | 'browser_disconnected'
  | 'browser_restarted';

export interface BrowserInvalidation {
  readonly channel: string;
  readonly reason: BrowserInvalidationReason;
}

export type BrowserInvalidationObserver = (
  invalidation: BrowserInvalidation,
) => Promise<void> | void;

export type BrowserManagerLogger = Pick<
  Logger,
  'debug' | 'info' | 'warn' | 'error'
>;

export type BrowserFatalRecoveryObserver = (request: {
  readonly reason: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}) => Promise<void> | void;

export interface BrowserRestartedEvent {
  readonly mode: 'automatic' | 'manual';
}

/** Fired after a successful browser restart/recycle (manual or automatic). */
export type BrowserRestartedObserver = (
  event: BrowserRestartedEvent,
) => void;

export interface BrowserManagerDependencies {
  readonly launcher?: BrowserLauncher;
  readonly logger?: BrowserManagerLogger;
  readonly onInvalidated?: BrowserInvalidationObserver;
  /** Called when browser recovery is exhausted or termination cannot be proved. */
  readonly onFatalRecovery?: BrowserFatalRecoveryObserver;
  /** Called after browser process is successfully replaced. */
  readonly onBrowserRestarted?: BrowserRestartedObserver;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly resourceCloseTimeoutMs?: number;
  readonly restartBackoffMs?: number;
  readonly restartBackoffMaxMs?: number;
  readonly maxAutomaticRestartAttempts?: number;
  readonly restartAttemptResetMs?: number;
}

export interface PageEntry {
  readonly adapter: BrowserPageAdapter;
  readonly browserGeneration: number;
  readonly pageGeneration: number;
  unsubscribeCrash: () => void;
  unsubscribeClose: () => void;
  unsubscribePopup: () => void;
  unsubscribeRequestFailed: () => void;
  unsubscribeResponse: () => void;
  unsubscribeConsole: () => void;
}

export interface DetachedResources {
  readonly browser: BrowserAdapter | undefined;
  readonly context: BrowserContextAdapter | undefined;
  readonly pages: readonly PageEntry[];
  readonly unsubscribeBrowser: (() => void) | undefined;
}

export interface RestartSchedule {
  readonly attempt: number;
  readonly delayMs: number;
  readonly recoveryEpoch: number;
}
