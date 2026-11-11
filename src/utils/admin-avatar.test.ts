import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdminAvatar } from './admin-avatar';

test('avatar rejects external URLs, markup, mismatched MIME and oversized input', () => {
  for (const value of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz4=', 'data:image/jpeg;base64,YWJj', '', 123, 'x'.repeat(2_800_001)]) {
    assert.throws(() => parseAdminAvatar(value));
  }
  assert.equal(parseAdminAvatar(null), null);
});
test('PNG, JPEG and WebP signatures are accepted for the existing image uploader to process', () => {
  for (const [type, bytes] of [
    ['png', Buffer.from([137,80,78,71,13,10,26,10,0])],
    ['jpeg', Buffer.from([255,216,255,224])],
    ['webp', Buffer.from('RIFF1234WEBP')],
  ] as const) {
    const uri = 'data:image/' + type + ';base64,' + bytes.toString('base64');
    assert.equal(parseAdminAvatar(uri), uri);
  }
});
