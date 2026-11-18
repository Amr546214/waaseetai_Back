import test from 'node:test';
import assert from 'node:assert/strict';
import { waseetAiClient } from '../ai/waseet-ai/waseet-ai.client';
import { guardAttachmentWithAi, ATTACHMENT_AI_MAX_BYTES } from './attachment-ai-guard';

const png = { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mimetype: 'image/png' };
const client = waseetAiClient as any;
const original = client.inspectAttachment;
const restore = () => { client.inspectAttachment = original; delete process.env.ATTACHMENT_AI_SCAN; };

test('disabled by default: nothing is sent to the AI', async () => {
	let called = false; client.inspectAttachment = async () => { called = true; return { status: 'CLEAN', categories: [], summaryAr: '' }; };
	assert.deepEqual(await guardAttachmentWithAi(png, 'SUPPORT_TICKET'), { scanned: false, reason: 'DISABLED' });
	assert.equal(called, false); restore();
});
test('enabled: BLOCK refuses with 422; REVIEW and CLEAN are accepted', async () => {
	process.env.ATTACHMENT_AI_SCAN = 'true';
	client.inspectAttachment = async () => ({ status: 'BLOCK', categories: ['EXPLICIT_SEXUAL'], summaryAr: 'x' });
	await assert.rejects(() => guardAttachmentWithAi(png, 'DISPUTE'), (e: any) => e.statusCode === 422);
	client.inspectAttachment = async () => ({ status: 'REVIEW', categories: ['CONTACT_INFO'], summaryAr: 'x' });
	assert.deepEqual(await guardAttachmentWithAi(png, 'DISPUTE'), { scanned: true, status: 'REVIEW', categories: ['CONTACT_INFO'] });
	client.inspectAttachment = async () => ({ status: 'CLEAN', categories: [], summaryAr: 'x' });
	assert.equal(((await guardAttachmentWithAi(png, 'DISPUTE')) as any).status, 'CLEAN'); restore();
});
test('AI failure is fail-open (accepted, reported as not scanned); big files and other types are not sent', async () => {
	process.env.ATTACHMENT_AI_SCAN = 'true';
	client.inspectAttachment = async () => { throw new Error('down'); };
	assert.deepEqual(await guardAttachmentWithAi(png, 'CLIENT_REQUEST'), { scanned: false, reason: 'AI_UNAVAILABLE' });
	let called = false; client.inspectAttachment = async () => { called = true; return { status: 'CLEAN', categories: [], summaryAr: '' }; };
	assert.deepEqual(await guardAttachmentWithAi({ buffer: Buffer.alloc(ATTACHMENT_AI_MAX_BYTES + 1), mimetype: 'image/png' }, 'SERVICE_GALLERY'), { scanned: false, reason: 'NOT_SCANNABLE' });
	assert.deepEqual(await guardAttachmentWithAi({ buffer: Buffer.from('zip'), mimetype: 'application/zip' }, 'SERVICE_GALLERY'), { scanned: false, reason: 'NOT_SCANNABLE' });
	assert.equal(called, false); restore();
});
