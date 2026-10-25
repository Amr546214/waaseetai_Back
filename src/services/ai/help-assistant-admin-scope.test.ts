import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// The remote AI service decides documents by the general `admin` role, where a staff member's permissions / sections cannot be enforced: for administrators it is SUPER_ADMIN-only, on EVERY entry point.
process.env.JWT_SECRET = 'x'; process.env.OPENAI_API_KEY = 'x';
const TYPES: Record<string, string> = { sa: 'SUPER_ADMIN', staff: 'ADMIN', client: 'CLIENT_INDIVIDUAL' };
mock.module('../../config/db', { namedExports: { prisma: { user: { findUnique: async ({ where }: any) => ({ accountType: TYPES[where.id], status: 'ACTIVE', isBanned: false }) } } } });
const load = async () => ({ ...(await import('./help-assistant-tools')), ...(await import('./help-assistant-tts')), ...(await import('./help-assistant-http')) });

const fx = (who: string, body: any = {}) => {
	const req: any = { body, query: {}, params: { runId: 'r' }, user: { id: who, activeRole: who === 'client' ? 'CLIENT' : 'ADMIN', accountType: TYPES[who] } };
	const res: any = new EventEmitter(); Object.assign(res, { statusCode: 200, writableEnded: false, headers: {}, status(c: number) { this.statusCode = c; return this; }, set() { return this; }, setHeader() { return this; }, json(v: any) { this.body = v; this.writableEnded = true; return this; }, send(v: any) { this.body = v; this.writableEnded = true; return this; } });
	return { req, res };
};
const spy = () => { const calls: any[] = []; return { calls, fn: async (...a: any[]) => { calls.push(a); return { text: 't' }; } }; };

test('tools (capabilities / stt / live): a staff member gets 403 and the AI service is never called; a SUPER_ADMIN and a client pass', async () => {
	const { createAssistantToolsHandlers } = await load(); const s = spy();
	const h = createAssistantToolsHandlers({ isBlocked: async () => false, client: { getCapabilities: s.fn, transcribe: s.fn, liveToken: s.fn, createRun: s.fn, runOperation: s.fn } as any });
	const staff = fx('staff'); await h.capabilities(staff.req, staff.res); assert.equal(staff.res.statusCode, 403); assert.equal(s.calls.length, 0);
	const sa = fx('sa'); await h.capabilities(sa.req, sa.res); assert.equal(sa.res.statusCode, 200); assert.equal(s.calls[0][0].actor.role, 'admin');
	const cl = fx('client'); await h.capabilities(cl.req, cl.res); assert.equal(cl.res.statusCode, 200);
});

test('voice (TTS): a staff member gets 403 before the synthesis service; a SUPER_ADMIN is served', async () => {
	const { createHelpAssistantTtsHandler } = await load(); let synth = 0;
	const h = createHelpAssistantTtsHandler({ client: { isConfigured: () => true, synthesizeSpeech: async () => { synth++; return Buffer.from('a'); } } as any, isBlocked: async () => false, isRateLimited: () => false });
	const staff = fx('staff', { text: 'مرحبا بك', voice: 'Puck', dialect: 'msa' }); await h(staff.req, staff.res); assert.equal(staff.res.statusCode, 403); assert.equal(synth, 0);
});

test('chat over HTTP: a staff member gets 403; the stream is never opened', async () => {
	const { createAssistantHttpHandler } = await load(); let streamed = 0;
	const h = createAssistantHttpHandler({ client: { streamHelpChat: async function* () { streamed++; } } as any, isBlocked: async () => false } as any);
	const staff = fx('staff', { message: 'سؤال' }); await h(staff.req, staff.res); assert.equal(staff.res.statusCode, 403); assert.equal(streamed, 0);
});
