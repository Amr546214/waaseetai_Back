import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

test('generateUniqueQuiz rejects invalid bounds before querying the database or AI', async t => {
  let calls = 0;
  t.mock.module('../config/db', { namedExports: { prisma: { question: { findMany: async () => { calls++; return []; } } } } });
  const { AssessmentService } = await import(`./assessment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const service = new AssessmentService();
  for (const [id, size, time] of [['', 5, 30], ['spec', 0, 30], ['spec', 51, 30], ['spec', 1.5, 30], ['spec', 5, 0], ['spec', 5, 181]] as const) {
    await assert.rejects(service.generateUniqueQuiz(id, [], size, { timeLimitMinutes: time }), (err: any) => err.statusCode === 400);
  }
  assert.equal(calls, 0);
});

test('generateUniqueQuiz: returns local DB questions when available and matching quiz size', async (t) => {
  const localQuestions = [
    { id: 'q1', text: 'سؤال 1', options: JSON.stringify([{ id: 'a', text: 'خيار 1' }]), correctOptionIndex: 0, explanation: 'شرح', subSpecialtyTag: 'برمجة' },
    { id: 'q2', text: 'سؤال 2', options: JSON.stringify([{ id: 'b', text: 'خيار 2' }]), correctOptionIndex: 1, explanation: 'شرح', subSpecialtyTag: 'برمجة' },
  ];

  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        question: { findMany: async () => localQuestions },
        specialty: { findUnique: async () => ({ nameAr: 'تطوير الويب' }) },
      },
    },
  });

  const { AssessmentService } = await import(`./assessment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const service = new AssessmentService();

  const result = await service.generateUniqueQuiz('spec-1', ['برمجة'], 2);

  assert.equal(result.length, 2);
  assert.equal(result[0].subSpecialtyTag, 'برمجة');
});

test('generateUniqueQuiz: delegates to Waseet AI Assessment Engine when local pool is empty', async (t) => {
  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        question: { findMany: async () => [] }, // Empty local pool
        specialty: { findUnique: async () => ({ nameAr: 'تطوير الويب' }) },
      },
    },
  });

  const createAssessmentSpy = t.mock.fn(async () => ({
    attemptId: 'attempt-ai-100',
    questions: [
      { id: 1, textAr: 'سؤال ذكي من Waseet AI', options: [{ id: 'a', text: 'أ' }, { id: 'b', text: 'ب' }] },
    ],
    timeLimitMinutes: 30,
  }));

  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        isConfigured: () => true,
        createAssessment: createAssessmentSpy,
      },
    },
  });

  const { AssessmentService } = await import(`./assessment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const service = new AssessmentService();

  const result = await service.generateUniqueQuiz('spec-1', ['تطوير'], 1);

  assert.equal(createAssessmentSpy.mock.calls.length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '1');
  assert.equal(result[0].text, 'سؤال ذكي من Waseet AI');
  assert.equal(result[0].correctOptionIndex, -1); // Answer key stays private on Waseet AI server
  assert.equal(result[0].attemptId, 'attempt-ai-100');
});

test('submitAssessment: delegates to waseetAiClient.submitAssessment', async (t) => {
  const submitSpy = t.mock.fn(async () => ({
    attemptId: 'att-1',
    score: 85,
    isPassed: true,
    status: 'COMPLETED',
    feedbackAr: 'أداء ممتاز',
    strengths: ['السرعة'],
    weaknesses: [],
  }));

  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        isConfigured: () => true,
        submitAssessment: submitSpy,
      },
    },
  });

  const { AssessmentService } = await import(`./assessment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const service = new AssessmentService();

  const result = await service.submitAssessment('att-1', {
    submittedAnswers: { '1': 'a' },
    timeSpentSeconds: 120,
  });

  assert.equal(submitSpy.mock.calls.length, 1);
  assert.equal(result.score, 85);
  assert.equal(result.isPassed, true);
});

test('generateUniqueQuiz: falls back to available local questions when Waseet AI throws an error', async (t) => {
  const localQuestions = [
    { id: 'q1', text: 'سؤال محلي بديل', options: JSON.stringify([{ id: 'a', text: 'خيار' }]), correctOptionIndex: 0, subSpecialtyTag: 'تطوير' },
  ];

  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        question: { findMany: async () => localQuestions },
        specialty: { findUnique: async () => ({ nameAr: 'تطوير' }) },
      },
    },
  });

  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        isConfigured: () => true,
        createAssessment: async () => { throw new Error('Waseet AI timeout'); },
      },
    },
  });

  const { AssessmentService } = await import(`./assessment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const service = new AssessmentService();

  const result = await service.generateUniqueQuiz('spec-1', ['تطوير'], 5, { preferAi: true });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'q1');
  assert.equal(result[0].text, 'سؤال محلي بديل');
});

test('generateUniqueQuiz: returns available local questions when Waseet AI is unconfigured and pool is smaller than quizSize', async (t) => {
  const localQuestions = [
    { id: 'q1', text: 'سؤال محلي', options: JSON.stringify([{ id: 'a', text: 'خيار' }]), correctOptionIndex: 0, subSpecialtyTag: 'تطوير' },
  ];

  t.mock.module('../config/db', {
    namedExports: {
      prisma: {
        question: { findMany: async () => localQuestions },
        specialty: { findUnique: async () => ({ nameAr: 'تطوير' }) },
      },
    },
  });

  t.mock.module('./ai/waseet-ai/waseet-ai.client', {
    namedExports: {
      waseetAiClient: {
        isConfigured: () => false,
      },
    },
  });

  const { AssessmentService } = await import(`./assessment.service.ts?fixture=${Date.now()}-${Math.random()}`);
  const service = new AssessmentService();

  const result = await service.generateUniqueQuiz('spec-1', ['تطوير'], 10);

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'q1');
});

