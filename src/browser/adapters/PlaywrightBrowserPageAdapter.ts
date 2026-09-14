import type { ConsoleMessage, Page, Request, Response } from 'playwright';

import { redactSensitiveString } from '../../logging/Logger.js';
import {
  extractGraphQlOperationNames,
  joinSanitizedUrl,
  MAX_FAILURE_TEXT_LENGTH,
  MAX_MESSAGE_LENGTH,
  sanitizeBrowserUrl,
  truncateText,
} from '../browser-diagnostics.js';
import type {
  BrowserConsoleDiagnostic,
  BrowserHttpResponseDiagnostic,
  BrowserPageAdapter,
  BrowserRequestFailureDiagnostic,
} from '../types.js';

export class PlaywrightBrowserPageAdapter implements BrowserPageAdapter {
  public constructor(public readonly page: Page) {}

  public async close(): Promise<void> {
    if (!this.page.isClosed()) {
      await this.page.close();
    }
  }

  public isClosed(): boolean {
    return this.page.isClosed();
  }

  public onCrash(listener: () => void): () => void {
    this.page.on('crash', listener);
    return () => {
      this.page.off('crash', listener);
    };
  }

  public onClose(listener: () => void): () => void {
    this.page.on('close', listener);
    return () => {
      this.page.off('close', listener);
    };
  }

  public onPopup(listener: (popup: Page) => void): () => void {
    this.page.on('popup', listener);
    return () => {
      this.page.off('popup', listener);
    };
  }

  public onRequestFailed(
    listener: (diagnostic: BrowserRequestFailureDiagnostic) => void,
  ): () => void {
    const handler = (request: Request): void => {
      try {
        const failure = request.failure();
        const failureText = truncateFailureText(failure?.errorText);
        const graphQlOperationNames = extractGraphQlOperationNames(
          safePostData(request),
        );
        listener({
          url: sanitizeUrlForDiagnostic(request.url()),
          method: request.method(),
          resourceType: request.resourceType(),
          ...(failureText === undefined ? {} : { failureText }),
          ...(graphQlOperationNames.length === 0
            ? {}
            : { graphQlOperationNames }),
        });
      } catch {
        // Diagnostics must never break page lifecycle listeners.
      }
    };
    this.page.on('requestfailed', handler);
    return () => {
      this.page.off('requestfailed', handler);
    };
  }

  public onResponse(
    listener: (diagnostic: BrowserHttpResponseDiagnostic) => void,
  ): () => void {
    const handler = (response: Response): void => {
      try {
        const request = response.request();
        const graphQlOperationNames = extractGraphQlOperationNames(
          safePostData(request),
        );
        listener({
          url: sanitizeUrlForDiagnostic(response.url()),
          method: request.method(),
          resourceType: request.resourceType(),
          status: response.status(),
          statusText: response.statusText(),
          ...(graphQlOperationNames.length === 0
            ? {}
            : { graphQlOperationNames }),
        });
      } catch {
        // Diagnostics must never break page lifecycle listeners.
      }
    };
    this.page.on('response', handler);
    return () => {
      this.page.off('response', handler);
    };
  }

  public onConsole(
    listener: (diagnostic: BrowserConsoleDiagnostic) => void,
  ): () => void {
    const handler = (message: ConsoleMessage): void => {
      try {
        const text = truncateText(
          redactSensitiveString(message.text()),
          MAX_MESSAGE_LENGTH,
        );
        const location = message.location();
        const sanitizedSourceUrl =
          location.url.length === 0
            ? undefined
            : sanitizeUrlForDiagnostic(location.url);
        const sourceUrl =
          sanitizedSourceUrl !== undefined && sanitizedSourceUrl.length > 0
            ? sanitizedSourceUrl
            : undefined;
        listener({
          type: message.type(),
          text,
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        });
      } catch {
        // Diagnostics must never break page lifecycle listeners.
      }
    };
    this.page.on('console', handler);
    return () => {
      this.page.off('console', handler);
    };
  }
}

function sanitizeUrlForDiagnostic(rawUrl: string): string {
  return joinSanitizedUrl(sanitizeBrowserUrl(rawUrl));
}

function safePostData(request: Request): string | undefined {
  try {
    return request.postData() ?? undefined;
  } catch {
    return undefined;
  }
}

function truncateFailureText(
  errorText: string | undefined,
): string | undefined {
  if (errorText === undefined || errorText.length === 0) {
    return undefined;
  }
  const redacted = redactSensitiveString(errorText);
  return truncateText(redacted, MAX_FAILURE_TEXT_LENGTH);
}
