import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorFromHttpStatus } from '../ai/waseet-ai/waseet-ai.errors';
import {
  knowledgeRetrievalService,
  normalizedTerms,
  cosine,
  rankKnowledge,
  StoredKnowledgeDoc,
  KnowledgeRetrievalService,
  PLATFORM_KNOWLEDGE_DOCS,
} from './knowledge-retrieval.service';

test('normalizedTerms: normalizes Arabic diacritics, alefs and yaas correctly', () => {
  const terms = normalizedTerms('السَّلَامُ عَلَيْكُمْ يا أخي إلى أينَ؟');
  assert.ok(terms.includes('السلام'));
  assert.ok(terms.includes('عليكم'));
  assert.ok(terms.includes('اخي'));
  assert.ok(terms.includes('الي'));
  assert.ok(terms.includes('اين'));
});

test('configured knowledge search forwards a trusted actor and removes private, other-owner and unapproved upstream documents', async () => {
  let body: any, opts: any;
  const publicDoc = PLATFORM_KNOWLEDGE_DOCS[0];
  const service = new KnowledgeRetrievalService([], { isConfigured: () => true, searchKnowledge: async (request: any, options: any) => {
    body = request; opts = options;
    return { retrievalMode: 'hybrid', documents: [publicDoc, { ...publicDoc, documentId: 'admin', audience: 'admin' },
      { ...publicDoc, documentId: 'other', ownerId: 'another-user' }, { ...publicDoc, documentId: 'draft', status: 'DRAFT' }] } as any;
  } });
  const result = await service.searchWithSource('الضمان المالي', { audience: 'admin', actor: { userId: 'verified-user', role: 'client' } });
  assert.equal(body.audience, 'all');
  assert.deepEqual(opts.actor, { userId: 'verified-user', role: 'client' });
  assert.deepEqual(result.documents.map(doc => doc.documentId), [publicDoc.documentId]);
  assert.equal(result.source, 'WASEET_KNOWLEDGE');
  assert.equal(result.retrievalMode, 'hybrid');
});

test('knowledge reports lexical fallback truthfully and guests never cause an upstream call', async () => {
  let calls = 0;
  const service = new KnowledgeRetrievalService(PLATFORM_KNOWLEDGE_DOCS, { isConfigured: () => true, searchKnowledge: async () => {
    calls++; throw new Error('unavailable');
  } });
  const guest = await service.searchWithSource('الضمان المالي', { audience: 'admin' });
  assert.equal(calls, 0);
  assert.equal(guest.source, 'LOCAL_LEXICAL');
  assert.equal(guest.fallbackReason, 'guest');
  const result = await service.searchWithSource('الضمان المالي', { actor: { userId: 'u', role: 'client' } });
  assert.equal(calls, 1);
  assert.equal(result.retrievalMode, 'lexical');
  assert.equal(result.fallbackReason, 'unavailable');
  assert.ok(result.documents.length > 0);
});

test('empty remote result stays empty and cancellation is never turned into local content', async () => {
  const controller = new AbortController();
  const service = new KnowledgeRetrievalService(PLATFORM_KNOWLEDGE_DOCS, { isConfigured: () => true, searchKnowledge: async () => ({ documents: [], retrievalMode: 'lexical' }) });
  const result = await service.searchWithSource('الضمان المالي', { actor: { userId: 'u', role: 'client' } });
  assert.deepEqual(result.documents, []);
  controller.abort(new Error('cancelled'));
  await assert.rejects(service.searchWithSource('الضمان المالي', { actor: { userId: 'u', role: 'client' }, signal: controller.signal }), /cancelled/);
});

test('knowledge authentication failures never turn into local results and local fallback ignores supplied vectors', async () => {
  const service = new KnowledgeRetrievalService(PLATFORM_KNOWLEDGE_DOCS, { isConfigured: () => true, searchKnowledge: async () => { throw errorFromHttpStatus(403); } });
  await assert.rejects(service.searchWithSource('الضمان', { actor: { userId: 'u', role: 'client' } }), (error: any) => error.status === 403);
  const doc = { ...PLATFORM_KNOWLEDGE_DOCS[0], embedding: [1, 0], embeddingModel: 'test' };
  const local = new KnowledgeRetrievalService([doc], { isConfigured: () => false, searchKnowledge: async () => { throw new Error('unexpected'); } });
  const result = await local.searchWithSource('unrelated', { queryEmbedding: [1, 0], embeddingModel: 'test' });
  assert.deepEqual(result.documents, []);
  assert.equal(result.retrievalMode, 'lexical');
});

test('normalizedTerms: handles null, non-string, empty text safely without throwing', () => {
  assert.deepEqual(normalizedTerms(null as any), []);
  assert.deepEqual(normalizedTerms(undefined as any), []);
  assert.deepEqual(normalizedTerms('' as any), []);
  assert.deepEqual(normalizedTerms(123 as any), []);
});


test('cosine: computes dot product divided by norms, handles zeros', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1, 2], [1]), 0);
});

test('rankKnowledge: ranks matching documents higher based on BM25 terms', () => {
  const sampleDocs: StoredKnowledgeDoc[] = [
    {
      documentId: 'doc-1',
      version: '1',
      title: 'الضمان المالي وحماية المعاملات',
      content: 'يتم حجز المبالغ في حساب ضمان مالي حتى يتم التسليم والموافقة.',
      locale: 'ar',
      status: 'APPROVED',
      audience: 'all',
      createdAt: '2026-01-01',
      approvedBy: 'admin',
      approvedAt: '2026-01-01',
    },
    {
      documentId: 'doc-2',
      version: '1',
      title: 'سياسة سحب الأرباح والعمولات',
      content: 'يتم تحويل الأرباح كل أسبوع يوم الأربعاء عبر حساب باي بال.',
      locale: 'ar',
      status: 'APPROVED',
      audience: 'all',
      createdAt: '2026-01-01',
      approvedBy: 'admin',
      approvedAt: '2026-01-01',
    },
  ];

  const results = rankKnowledge('الضمان المالي حجز المبالغ', sampleDocs);
  assert.ok(results.length > 0);
  assert.equal(results[0].documentId, 'doc-1');
});

test('knowledgeRetrievalService.search: finds escrow policy for escrow query', async () => {
  const results = await knowledgeRetrievalService.search('كيف يعمل الضمان المالي لحماية أموالي؟');
  assert.ok(results.length > 0);
  assert.equal(results[0].documentId, 'policy-escrow');
  assert.match(results[0].content, /Escrow/);
});

test('knowledgeRetrievalService.search: finds dispute policy for dispute query', async () => {
  const results = await knowledgeRetrievalService.search('متى يحق لي فتح نزاع؟');
  assert.ok(results.length > 0);
  assert.equal(results[0].documentId, 'policy-disputes');
  assert.match(results[0].content, /نزاع/);
});

test('knowledgeRetrievalService.search: respects audience filters', async () => {
  // policy-accreditation is audience: provider
  const clientResults = await knowledgeRetrievalService.search('اعتماد التخصص', { audience: 'client' });
  assert.ok(!clientResults.some((d) => d.documentId === 'policy-accreditation'));

  const providerResults = await knowledgeRetrievalService.search('اعتماد التخصص', { audience: 'provider' });
  assert.ok(providerResults.some((d) => d.documentId === 'policy-accreditation'));
});
