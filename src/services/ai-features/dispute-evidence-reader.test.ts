import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDisputeFiles, disputeEvidenceDeps, DISPUTE_FILE_MAX_READ, type DisputeFileRef } from './dispute-evidence-reader';

const actor = { userId: 'u', role: 'admin' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const png = (url: string, extra: Partial<DisputeFileRef> = {}): DisputeFileRef => ({ by: 'العميل', name: 'a.png', mimeType: 'image/png', url, origin: 'دليل مرفق بالنزاع', ...extra });

function withDeps<T>(fetchBytes: (u: string) => Promise<Buffer>, readAttachment: (b: any) => Promise<any>, run: () => Promise<T>) {
  const saved = { ...disputeEvidenceDeps };
  disputeEvidenceDeps.fetchBytes = fetchBytes;
  disputeEvidenceDeps.reader = { readAttachment } as any;
  return run().finally(() => Object.assign(disputeEvidenceDeps, saved));
}

test('a link outside our storage is never fetched', async () => {
  let fetched = 0;
  const out = await withDeps(async () => { fetched++; return PNG; }, async () => ({ kind: 'IMAGE', text: 'x', truncated: false, readable: true }),
    () => readDisputeFiles([png('https://evil.example.com/a.png')], actor));
  assert.equal(fetched, 0);
  assert.equal(out[0].readable, false);
  assert.match(out[0].reason!, /خارج تخزين المنصة/);
});

test('archives and oversize files are reported unread without a fetch; a mismatching signature is refused', async () => {
  let fetched = 0;
  const out = await withDeps(async () => { fetched++; return Buffer.from('not a png at all, just text'); }, async () => ({ kind: 'IMAGE', text: 'x', truncated: false, readable: true }), () => readDisputeFiles([
    { by: 'العميل', name: 'src.zip', mimeType: 'application/zip', origin: 'ملف نزاع', privateRef: 'r' },
    { by: 'العميل', name: 'big.png', mimeType: 'image/png', bytes: 5_000_000, origin: 'ملف نزاع', privateRef: 'r' },
    png('https://res.cloudinary.com/x/image/upload/a.png', { bytes: 100 }),
  ], actor));
  assert.deepEqual(out.map(o => o.readable), [false, false, false]);
  assert.match(out[0].reason!, /الأرشيف/); assert.match(out[1].reason!, /2 ميجابايت/);
  assert.ok(fetched <= 1);
});

test('files past the read cap are reported as unread, in order, and a failing reader does not break the others', async () => {
  const prev = process.env.CLOUDINARY_CLOUD_NAME; process.env.CLOUDINARY_CLOUD_NAME = 'demo';
  try {
    let calls = 0;
    const refs = Array.from({ length: DISPUTE_FILE_MAX_READ + 2 }, (_, i) => png(`https://res.cloudinary.com/demo/image/upload/f${i}.png`, { name: `f${i}.png` }));
    const out = await withDeps(async () => PNG, async () => { if (++calls === 2) throw new Error('boom'); return { kind: 'IMAGE', text: 'وصف الصورة', truncated: false, readable: true }; }, () => readDisputeFiles(refs, actor));
    assert.equal(out.length, refs.length);
    assert.equal(out.filter(o => o.readable).length, DISPUTE_FILE_MAX_READ - 1);
    assert.match(out[DISPUTE_FILE_MAX_READ].reason!, /تجاوز حد القراءة/);
    assert.equal(out.filter(o => o.reason?.startsWith('تعذّرت القراءة')).length, 1);
  } finally { if (prev === undefined) delete process.env.CLOUDINARY_CLOUD_NAME; else process.env.CLOUDINARY_CLOUD_NAME = prev; }
});
