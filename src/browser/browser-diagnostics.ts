import { redactSensitiveString } from '../logging/Logger.js';

export type EndpointCategory =
  | 'twitch_document'
  | 'twitch_javascript'
  | 'twitch_graphql'
  | 'twitch_anti_abuse'
  | 'twitch_api'
  | 'twitch_media'
  | 'twitch_other'
  | 'third_party'
  | 'unknown';

export interface SanitizedEndpoint {
  readonly host: string;
  readonly path: string;
  readonly endpointCategory: EndpointCategory;
}

/** Hostname output bound; longer values are truncated. */
export const MAX_HOST_LENGTH = 128;
/** Path output bound; longer values are truncated. */
export const MAX_PATH_LENGTH = 256;
/** Console message output bound; longer values are truncated. */
export const MAX_MESSAGE_LENGTH = 500;
/** Request failure text output bound; longer values are truncated. */
export const MAX_FAILURE_TEXT_LENGTH = 300;
/** Maximum GraphQL operation names recorded per diagnostic event. */
export const MAX_GRAPHQL_OPERATION_NAMES = 5;
/** Per-operation-name string bound. */
export const MAX_GRAPHQL_OPERATION_NAME_LENGTH = 64;

export const REDACTED_URL = '[REDACTED]';

/** Log level decision shared by response and console diagnostics. */
export type DiagnosticLogLevel = 'warn' | 'debug' | 'none';

const TWITCH_DOCUMENT_HOSTS = new Set([
  'twitch.tv',
  'www.twitch.tv',
  'm.twitch.tv',
]);

const TWITCH_API_HOSTS = new Set(['api.twitch.tv']);

const TWITCH_GRAPHQL_HOSTS = new Set(['gql.twitch.tv']);

const TWITCH_ANTI_ABUSE_HOSTS = new Set(['k.twitchcdn.net']);

const TWITCH_JAVASCRIPT_HOSTS = new Set([
  'assets.twitch.tv',
  'static.twitchcdn.net',
]);

/** Resource types worth logging on 4xx failures or successful bootstrap responses. */
const RELEVANT_RESOURCE_TYPES = new Set([
  'document',
  'script',
  'xhr',
  'fetch',
]);

/**
 * Parse and sanitize an arbitrary browser URL. Only the normalized hostname
 * and pathname are kept; username, password, port, query, and fragment are
 * dropped. Parsing failures return a bounded redacted placeholder and never
 * throw.
 */
export function sanitizeBrowserUrl(
  rawUrl: string | null | undefined,
): SanitizedEndpoint {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { host: REDACTED_URL, path: '', endpointCategory: 'unknown' };
  }

  try {
    const parsed = parseUrl(rawUrl);
    const host = truncateText(parsed.hostname, MAX_HOST_LENGTH);
    const path = truncateText(parsed.pathname, MAX_PATH_LENGTH);
    return {
      host,
      path,
      endpointCategory: classifyHostname(parsed.hostname),
    };
  } catch {
    return { host: REDACTED_URL, path: '', endpointCategory: 'unknown' };
  }
}

/** Parse absolute URLs, or host+path fragments emitted by diagnostics. */
function parseUrl(rawUrl: string): URL {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(rawUrl)) {
    return new URL(rawUrl);
  }
  return new URL(`https://${rawUrl}`);
}

/**
 * Classify an endpoint by hostname. Rules are intentionally conservative:
 * a category describes the observed endpoint and must not claim that the
 * request is malicious, tracking-only, or safe to block.
 */
export function classifyHostname(hostname: string): EndpointCategory {
  const normalized = hostname.trim().toLocaleLowerCase('en-US');
  if (normalized.length === 0) {
    return 'unknown';
  }
  if (
    TWITCH_GRAPHQL_HOSTS.has(normalized) ||
    isSubdomainOf(normalized, 'gql.twitch.tv')
  ) {
    return 'twitch_graphql';
  }
  if (
    TWITCH_ANTI_ABUSE_HOSTS.has(normalized) ||
    isSubdomainOf(normalized, 'k.twitchcdn.net')
  ) {
    return 'twitch_anti_abuse';
  }
  if (
    TWITCH_API_HOSTS.has(normalized) ||
    isSubdomainOf(normalized, 'api.twitch.tv')
  ) {
    return 'twitch_api';
  }
  if (TWITCH_DOCUMENT_HOSTS.has(normalized)) {
    return 'twitch_document';
  }
  if (
    TWITCH_JAVASCRIPT_HOSTS.has(normalized) ||
    isSubdomainOf(normalized, 'static.twitchcdn.net') ||
    isSubdomainOf(normalized, 'jtvnw.net')
  ) {
    return 'twitch_javascript';
  }
  if (isSubdomainOf(normalized, 'ttvnw.net')) {
    return 'twitch_media';
  }
  if (isSubdomainOf(normalized, 'twitch.tv')) {
    return 'twitch_other';
  }
  return 'third_party';
}

function isSubdomainOf(hostname: string, suffix: string): boolean {
  return (
    hostname.length > suffix.length &&
    hostname.endsWith(`.${suffix}`)
  );
}

/**
 * Extract string-valued `operationName` fields from a GraphQL POST body.
 * Accepts a single operation object or a batched array. Variables,
 * extensions, hashes, and the raw body are never retained or logged.
 * Malformed JSON yields no operation names and never throws.
 */
export function extractGraphQlOperationNames(
  postData: string | null | undefined,
): readonly string[] {
  if (typeof postData !== 'string' || postData.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    return [];
  }

  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue;
    }
    const operationName = (candidate as Record<string, unknown>).operationName;
    if (typeof operationName !== 'string' || operationName.trim() === '') {
      continue;
    }
    const bounded = truncateText(
      redactSensitiveString(operationName),
      MAX_GRAPHQL_OPERATION_NAME_LENGTH,
    );
    if (names.includes(bounded)) {
      continue;
    }
    names.push(bounded);
    if (names.length >= MAX_GRAPHQL_OPERATION_NAMES) {
      break;
    }
  }
  return names;
}

/**
 * Decide whether an HTTP response is worth logging and at which level.
 * Routine media segments, images, fonts, and successful third-party
 * analytics responses are excluded.
 */
export function decideHttpResponseLevel(
  status: number,
  resourceType: string,
  endpointCategory: EndpointCategory,
): DiagnosticLogLevel {
  if (
    endpointCategory === 'twitch_media' ||
    resourceType === 'image' ||
    resourceType === 'font' ||
    resourceType === 'media'
  ) {
    return 'none';
  }

  if (status >= 500) {
    return 'warn';
  }

  if (status >= 400) {
    if (
      endpointCategory === 'twitch_graphql' ||
      endpointCategory === 'twitch_anti_abuse' ||
      RELEVANT_RESOURCE_TYPES.has(resourceType)
    ) {
      return 'warn';
    }
    return 'none';
  }

  if (
    status >= 200 &&
    (endpointCategory === 'twitch_document' ||
      endpointCategory === 'twitch_javascript' ||
      endpointCategory === 'twitch_graphql' ||
      endpointCategory === 'twitch_anti_abuse' ||
      endpointCategory === 'twitch_api') &&
    RELEVANT_RESOURCE_TYPES.has(resourceType)
  ) {
    return 'debug';
  }

  return 'none';
}

/**
 * Map a console message type to a log level: `error` maps to `warn`,
 * `warning`/`warn` to `debug`, and ordinary `log`, `info`, `debug`,
 * table, timing, and trace messages are ignored.
 */
export function decideConsoleLevel(
  consoleType: string,
): DiagnosticLogLevel {
  const normalized = consoleType.trim().toLocaleLowerCase('en-US');
  if (normalized === 'error') {
    return 'warn';
  }
  if (normalized === 'warning' || normalized === 'warn') {
    return 'debug';
  }
  return 'none';
}

/** Truncate free-form text to at most `max` characters. */
export function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, max);
}

/** Join a sanitized host and path back into a single query-free URL. */
export function joinSanitizedUrl(endpoint: SanitizedEndpoint): string {
  if (endpoint.path.length === 0) {
    return endpoint.host;
  }
  return `${endpoint.host}${endpoint.path}`;
}
