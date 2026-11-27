import { describe, expect, test } from 'vitest';
import { SNAPSHOT_IFRAME_SANDBOX, escapeHtmlAttribute, stripActiveContent } from './snapshot-html';
import { isAllowedThumbnailRequest } from './server-screenshot';

describe('snapshot iframe sandbox', () => {
  test('grants nothing: no scripts, no same-origin', () => {
    expect(SNAPSHOT_IFRAME_SANDBOX).toBe('');
  });
});

describe('escapeHtmlAttribute', () => {
  test('cannot break out of a double-quoted attribute', () => {
    const out = escapeHtmlAttribute(`"><script>alert(1)</script><x a="&`);
    expect(out).not.toMatch(/["<>]/);
    expect(out).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;x a=&quot;&amp;');
  });
});

describe('stripActiveContent', () => {
  test.each([
    ['<p>hi</p><script>fetch("/api/x")</script>', '<p>hi</p>'],
    ['<script src="https://evil.test/x.js"></script><b>x</b>', '<b>x</b>'],
    ['<SCRIPT>a</SCRIPT >ok', 'ok'],
    ['<img src="x" onerror="alert(1)">', '<img src="x">'],
    ["<div onclick='a()' class=\"c\">t</div>", '<div class="c">t</div>'],
    ['<a href="javascript:alert(1)">l</a>', '<a href="about:blank#alert(1)">l</a>'],
    ['<iframe src="https://evil.test"></iframe>x', 'x'],
    ['<base href="https://evil.test/">x', 'x'],
    ['<meta http-equiv="refresh" content="0;url=https://evil.test">x', 'x'],
    ['<object data="x"></object><embed src="y">x', 'x'],
  ])('%s', (input, expected) => {
    expect(stripActiveContent(input)).toBe(expected);
  });

  test('keeps ordinary styling and images', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><img src="data:image/png;base64,AA=="><p class="a">x</p></body></html>';
    expect(stripActiveContent(html)).toBe(html);
  });
});

describe('isAllowedThumbnailRequest (server renderer network policy)', () => {
  test.each([
    'data:image/png;base64,AA==',
    'https://fonts.gstatic.com/s/inter.woff2',
    'https://images.example.com/a.png',
  ])('allows %s', (url) => {
    expect(isAllowedThumbnailRequest(url)).toBe(true);
  });

  test.each([
    'http://example.com/a.png',
    'http://127.0.0.1:9001/2018-06-01/runtime/invocation/next',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://0x7f000001/',
    'https://localhost/',
    'https://api.localhost/',
    'https://metadata/',
    'https://example.com:8443/',
    'https://user:pass@example.com/',
    'https://service.internal/',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'not a url',
  ])('blocks %s', (url) => {
    expect(isAllowedThumbnailRequest(url)).toBe(false);
  });
});
