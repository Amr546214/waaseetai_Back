import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyAssistantMessage, streamAssistantAnswer } from './assistant-answer';
import { WaseetAiError, WaseetAiErrorCode } from './waseet-ai/waseet-ai.errors';

test('legacy general questions use the real unrestricted avatar endpoint with identity, bounded history and no audio', async () => {
  const calls: any[] = [];
  const client = {
    async *streamHelpChat() { throw new Error('restricted route must not receive general questions'); },
    async avatarChat(body: any, options: any) { calls.push({ body, options }); return { text: 'الـ API واجهة للتواصل بين البرامج.' }; },
  };
  const events = await Array.fromAsync(streamAssistantAnswer({ mode: 'general', question: 'اشرح API', skin: 'scout', history: [{ role: 'user', content: 'اشرح JavaScript' }] }, { actor: { userId: 'verified', role: 'client' } }, client, true));
  assert.match(calls[0].body.message, /نديم/);
  assert.match(calls[0].body.message, /JavaScript/);
  assert.equal(calls[0].body.includeBase64, false);
  assert.deepEqual(calls[0].options.actor, { userId: 'verified', role: 'client' });
  assert.equal(events.at(-1)?.type, 'completed');
  assert.match(events.find(event => event.type === 'delta')!.chunk, /API/);
});

test('missing approved policy still returns a useful general answer, without leaking discarded citations or private context', async () => {
  let fallbackMessage = '';
  const client = {
    async *streamHelpChat() {
      yield { type: 'started' as const };
      yield { type: 'citations' as const, citations: [{ docId: 'irrelevant', title: 'غير مطابق' }] };
      throw new WaseetAiError(WaseetAiErrorCode.STREAM_ERROR, 'missing', { humanSupportFallback: true });
    },
    async avatarChat(body: any) { fallbackMessage = body.message; return { text: 'الضمان يحتفظ بالمبلغ حتى اكتمال الالتزامات المتفق عليها.' }; },
  };
  const events = await Array.fromAsync(streamAssistantAnswer({ mode: 'policy', question: 'ما سياسة الضمان في وسيط؟', history: [{ role: 'user', content: 'private-account-record' }] }, {}, client, true));
  assert.doesNotMatch(fallbackMessage, /private-account-record|وسيط/);
  assert.equal(events.some(event => event.type === 'citations' && event.citations.some(citation => citation.docId === 'irrelevant')), false);
  assert.match(events.find(event => event.type === 'delta')!.chunk, /شرح عام/);
  assert.equal(events.at(-1)?.type, 'completed');
});

test('signed modern service keeps native help history and citations', async () => {
  let avatarCalls = 0;
  const events = await Array.fromAsync(streamAssistantAnswer({ mode: 'general', question: 'اشرح API' }, {}, {
    async *streamHelpChat() { yield { type: 'citations' as const, citations: [{ docId: 'source', title: 'دليل' }] }; yield { type: 'delta' as const, chunk: 'إجابة' }; yield { type: 'completed' as const }; },
    async avatarChat() { avatarCalls++; return { text: 'unused' }; },
  }, false));
  assert.equal(avatarCalls, 0);
  assert.deepEqual(events.map(event => event.type), ['citations', 'delta', 'completed']);
});

test('legacy successful refusal split across chunks becomes a useful general explanation', async () => {
  const events = await Array.fromAsync(streamAssistantAnswer({ mode: 'policy', question: 'سياسة وسيط عن Rust' }, {}, {
    async *streamHelpChat() {
      yield { type: 'delta' as const, chunk: 'عذراً، لا توجد معل' };
      yield { type: 'delta' as const, chunk: 'ومات في المستندات المعتمدة بشأن Rust.' };
      yield { type: 'citations' as const, citations: [{ docId: 'irrelevant', title: 'غير مطابق' }] };
      yield { type: 'completed' as const };
    },
    async avatarChat() { return { text: 'يمكن استخدام Rust لتطوير خدمات المتجر بحسب متطلباته.' }; },
  }, true));
  const reply = events.filter(event => event.type === 'delta').map(event => event.chunk).join('');
  assert.match(reply, /شرح عام/);
  assert.match(reply, /يمكن استخدام Rust/);
  assert.doesNotMatch(reply, /لا تتوفر/);
  assert.equal(events.some(event => event.type === 'citations' && event.citations.length), false);
});

test('a policy answer missing a specific term remains grounded when it explains the available policy', async () => {
  let avatarCalls = 0;
  const reply = 'لا يوجد ذكر لمصطلح العربون في المستندات. أما الضمان فيحفظ المبلغ حسب السياسة المعتمدة.';
  const events = await Array.fromAsync(streamAssistantAnswer({ mode: 'policy', question: 'العربون والضمان' }, {}, {
    async *streamHelpChat() { yield { type: 'delta' as const, chunk: reply }; yield { type: 'completed' as const }; },
    async avatarChat() { avatarCalls++; return { text: 'unused' }; },
  }, true));
  assert.equal(avatarCalls, 0);
  assert.equal(events.find(event => event.type === 'delta')!.chunk, reply);
});

test('service errors and partial answers cannot silently turn into another answer', async () => {
  let avatarCalls = 0;
  for (const partial of [false, true]) {
    await assert.rejects(async () => Array.fromAsync(streamAssistantAnswer({ mode: 'policy', question: 'سياسة' }, {}, {
      async *streamHelpChat() { if (partial) yield { type: 'delta' as const, chunk: 'جزء من الرد' }; throw new WaseetAiError(WaseetAiErrorCode.STREAM_ERROR, 'x', { humanSupportFallback: partial }); },
      async avatarChat() { avatarCalls++; return { text: 'unused' }; },
    }, true)));
  }
  assert.equal(avatarCalls, 0);
});

test('cancelled or empty avatar responses never publish a successful answer', async () => {
  const controller = new AbortController();
  const events = await Array.fromAsync(streamAssistantAnswer({ mode: 'general', question: 'اشرح API' }, { signal: controller.signal }, {
    async *streamHelpChat() {}, async avatarChat() { controller.abort(); return { text: 'stale' }; },
  }, true));
  assert.equal(events.some(event => event.type === 'delta' || event.type === 'completed'), false);
  await assert.rejects(async () => Array.fromAsync(streamAssistantAnswer({ mode: 'general', question: 'اشرح API' }, {}, {
    async *streamHelpChat() {}, async avatarChat() { return { text: ' ' }; },
  }, true)));
});

test('legacy message is bounded and credentials/private identifiers in history are scrubbed', () => {
  const message = legacyAssistantMessage({ question: 'فاكر كلامي؟', skin: 'classic', history: Array.from({ length: 20 }, () => ({ role: 'user' as const, content: 'اتصل بي على 0501234567 ' + 'س'.repeat(8_000) })) });
  assert.ok(message.length <= 8_000);
  assert.match(message, /بيبو/);
  assert.doesNotMatch(message, /0501234567/);
  const generalFallback = legacyAssistantMessage({ question: 'Waseet policy for Rust?', skin: 'scout', dialect: 'english', profile: 'fast' }, true);
  assert.match(generalFallback, /English/);
  assert.match(generalFallback, /مختصر ومباشر/);
  assert.doesNotMatch(generalFallback, /Waseet policy/);
});
