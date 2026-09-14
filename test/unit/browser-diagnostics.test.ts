import { describe, expect, it } from 'vitest';

import {
  MAX_GRAPHQL_OPERATION_NAMES,
  MAX_GRAPHQL_OPERATION_NAME_LENGTH,
  MAX_HOST_LENGTH,
  MAX_PATH_LENGTH,
  REDACTED_URL,
  decideConsoleLevel,
  decideHttpResponseLevel,
  extractGraphQlOperationNames,
  sanitizeBrowserUrl,
  truncateText,
} from '../../src/browser/browser-diagnostics.js';

describe('sanitizeBrowserUrl', () => {
  it('移除 query、fragment、credentials 與 port', () => {
    const result = sanitizeBrowserUrl(
      'https://user:pass@static.twitchcdn.net:8443/assets/main.js?token=secret&challenge=abc#frag',
    );

    expect(result).toEqual({
      host: 'static.twitchcdn.net',
      path: '/assets/main.js',
      endpointCategory: 'twitch_javascript',
    });
  });

  it('空值與非字串輸入回傳 redacted placeholder', () => {
    expect(sanitizeBrowserUrl(undefined)).toEqual({
      host: REDACTED_URL,
      path: '',
      endpointCategory: 'unknown',
    });
    expect(sanitizeBrowserUrl(null)).toEqual({
      host: REDACTED_URL,
      path: '',
      endpointCategory: 'unknown',
    });
    expect(sanitizeBrowserUrl('')).toEqual({
      host: REDACTED_URL,
      path: '',
      endpointCategory: 'unknown',
    });
  });

  it('無法解析的 URL 回傳 bounded 的 redacted 結果且不拋錯', () => {
    expect(sanitizeBrowserUrl('not a url')).toEqual({
      host: REDACTED_URL,
      path: '',
      endpointCategory: 'unknown',
    });
    expect(sanitizeBrowserUrl('https://')).toEqual({
      host: REDACTED_URL,
      path: '',
      endpointCategory: 'unknown',
    });
  });

  it('query 值與敏感 token 永遠不會出現在輸出', () => {
    const result = sanitizeBrowserUrl(
      'https://k.twitchcdn.net/kauth.js?token=Bearer+secret&client_id=abc',
    );

    expect(result.host).toBe('k.twitchcdn.net');
    expect(result.path).toBe('/kauth.js');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('client_id');
  });

  it('過長的 host 與 path 依上限裁切', () => {
    const longHost = `sub.${'a'.repeat(400)}.example.com`;
    const longPath = `/${'b'.repeat(400)}.js`;
    const result = sanitizeBrowserUrl(
      `https://${longHost}${longPath}?query=1`,
    );

    expect(result.host.length).toBe(MAX_HOST_LENGTH);
    expect(result.path.length).toBe(MAX_PATH_LENGTH);
  });
});

describe('endpoint classification', () => {
  it.each([
    ['https://www.twitch.tv/some_channel', 'twitch_document'],
    ['https://m.twitch.tv/some_channel', 'twitch_document'],
    ['https://static.twitchcdn.net/assets/main.js', 'twitch_javascript'],
    ['https://webpack.static.twitchcdn.net/main.123.js', 'twitch_javascript'],
    ['https://assets.twitch.tv/main.js', 'twitch_javascript'],
    ['https://static-cdn.jtvnw.net/app.js', 'twitch_javascript'],
    ['https://gql.twitch.tv/gql', 'twitch_graphql'],
    ['https://k.twitchcdn.net/kauth.js', 'twitch_anti_abuse'],
    ['https://api.twitch.tv/helix/streams', 'twitch_api'],
    [
      'https://video-weaver.atl01.hls.ttvnw.net/v1/playlist/segment.ts',
      'twitch_media',
    ],
    ['https://passport.twitch.tv/auth', 'twitch_other'],
    ['https://example.com/analytics.js', 'third_party'],
  ])('%s 分類為 %s', (url, expected) => {
    expect(sanitizeBrowserUrl(url).endpointCategory).toBe(expected);
  });
});

describe('extractGraphQlOperationNames', () => {
  it('從單一 operation 物件抽出 operationName', () => {
    const names = extractGraphQlOperationNames(
      JSON.stringify({
        operationName: 'PlaybackAccessToken',
        variables: { login: 'secret_channel' },
        extensions: { persistedQuery: { sha256Hash: 'hash-value' } },
      }),
    );

    expect(names).toEqual(['PlaybackAccessToken']);
  });

  it('從 batch 陣列抽出唯一 operationName 並忽略 variables 與 hashes', () => {
    const names = extractGraphQlOperationNames(
      JSON.stringify([
        { operationName: 'A', variables: { x: 1 } },
        { operationName: 'B', extensions: { sha256Hash: 'h' } },
        { operationName: 'A' },
      ]),
    );

    expect(names).toEqual(['A', 'B']);
    expect(JSON.stringify(names)).not.toContain('variables');
    expect(JSON.stringify(names)).not.toContain('sha256Hash');
  });

  it('無效 JSON 回傳空陣列且不拋錯', () => {
    expect(extractGraphQlOperationNames('{invalid')).toEqual([]);
    expect(extractGraphQlOperationNames(null)).toEqual([]);
    expect(extractGraphQlOperationNames(undefined)).toEqual([]);
    expect(extractGraphQlOperationNames('')).toEqual([]);
  });

  it('非物件或非字串 operationName 一律忽略', () => {
    expect(extractGraphQlOperationNames(JSON.stringify([1, 'a', true]))).toEqual([]);
    expect(extractGraphQlOperationNames(JSON.stringify({ operationName: 42 }))).toEqual([]);
    expect(extractGraphQlOperationNames(JSON.stringify({ operationName: '' }))).toEqual([]);
  });

  it('超過數量上限時只保留前 N 個', () => {
    const operations = Array.from(
      { length: MAX_GRAPHQL_OPERATION_NAMES + 3 },
      (_item, index) => ({ operationName: `Op${index}` }),
    );
    const names = extractGraphQlOperationNames(JSON.stringify(operations));

    expect(names).toHaveLength(MAX_GRAPHQL_OPERATION_NAMES);
    expect(names).toEqual(['Op0', 'Op1', 'Op2', 'Op3', 'Op4']);
  });

  it('過長 operationName 依上限裁切', () => {
    const longName = 'x'.repeat(MAX_GRAPHQL_OPERATION_NAME_LENGTH + 10);
    const names = extractGraphQlOperationNames(
      JSON.stringify({ operationName: longName }),
    );

    expect(names).toEqual([
      'x'.repeat(MAX_GRAPHQL_OPERATION_NAME_LENGTH),
    ]);
  });
});

describe('decideHttpResponseLevel', () => {
  it.each([
    [503, 'script', 'twitch_javascript', 'warn'],
    [500, 'document', 'twitch_document', 'warn'],
    [404, 'document', 'twitch_document', 'warn'],
    [401, 'fetch', 'third_party', 'warn'],
    [429, 'xhr', 'twitch_graphql', 'warn'],
    [403, 'other', 'twitch_anti_abuse', 'warn'],
    [403, 'other', 'third_party', 'none'],
    [404, 'fetch', 'twitch_media', 'none'],
    [200, 'script', 'twitch_javascript', 'debug'],
    [200, 'document', 'twitch_document', 'debug'],
    [200, 'fetch', 'twitch_graphql', 'debug'],
    [200, 'xhr', 'twitch_api', 'debug'],
    [200, 'image', 'twitch_javascript', 'none'],
    [200, 'font', 'twitch_document', 'none'],
    [200, 'media', 'twitch_media', 'none'],
    [200, 'fetch', 'third_party', 'none'],
    [302, 'document', 'twitch_document', 'debug'],
  ])(
    'status %s / %s / %s → %s',
    (status, resourceType, category, expected) => {
      expect(
        decideHttpResponseLevel(
          status as number,
          resourceType as string,
          category as Parameters<typeof decideHttpResponseLevel>[2],
        ),
      ).toBe(expected);
    },
  );
});

describe('decideConsoleLevel', () => {
  it.each([
    ['error', 'warn'],
    ['warning', 'debug'],
    ['warn', 'debug'],
    ['log', 'none'],
    ['info', 'none'],
    ['debug', 'none'],
    ['table', 'none'],
    ['timeEnd', 'none'],
    ['trace', 'none'],
  ])('%s → %s', (type, expected) => {
    expect(decideConsoleLevel(type)).toBe(expected);
  });
});

describe('truncateText', () => {
  it('超過上限時裁切，未超過時原樣回傳', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('1234567890', 5)).toBe('12345');
    expect(truncateText('1234567890', 5).length).toBe(5);
  });
});
