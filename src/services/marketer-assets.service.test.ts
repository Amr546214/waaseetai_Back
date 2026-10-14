import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketerAssetsService } from './marketer-assets.service';
import { MARKETING_ASSETS } from '../config/marketing-assets.config';

test('empty state: nothing published = an empty list (no invented banner or template)', () => {
  assert.deepEqual(marketerAssetsService.list([]), { items: [] });
});

test('list assets: every published file carries its kind, title and a real https download link', () => {
  const out = marketerAssetsService.list([
    { id: 'a1', kind: 'BANNER', title: 'بنر 1200x628', description: 'للمنشورات', downloadUrl: 'https://cdn.example.com/banner.png' },
    { id: 'a2', kind: 'TEMPLATE', title: 'قالب رسالة', downloadUrl: 'https://cdn.example.com/template.pdf' }
  ]);
  assert.equal(out.items.length, 2);
  assert.deepEqual(out.items[0], { id: 'a1', kind: 'BANNER', title: 'بنر 1200x628', description: 'للمنشورات', downloadUrl: 'https://cdn.example.com/banner.png' });
  assert.equal(out.items[1].description, null);
  for (const i of out.items) assert.match(i.downloadUrl, /^https:\/\//);
});

test('download link exists: an entry without a real https URL (empty, http, javascript:, spaces) is dropped, not shown as a dead link', () => {
  const out = marketerAssetsService.list([
    { id: 'x1', kind: 'FILE', title: 'a', downloadUrl: '' },
    { id: 'x2', kind: 'FILE', title: 'b', downloadUrl: 'http://insecure.example.com/f.pdf' },
    { id: 'x3', kind: 'FILE', title: 'c', downloadUrl: 'javascript:alert(1)' },
    { id: 'x4', kind: 'FILE', title: 'd', downloadUrl: 'https://cdn.example.com/a b.pdf' },
    { id: 'ok', kind: 'FILE', title: 'e', downloadUrl: 'https://cdn.example.com/ok.pdf' }
  ]);
  assert.deepEqual(out.items.map(i => i.id), ['ok']);
});

test('the shipped config ships empty (no placeholder assets)', () => {
  assert.deepEqual(MARKETING_ASSETS, []);
});
