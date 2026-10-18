import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistantOptionsSchema, greetingForDialect, greetingResponseForSkin, resolveAssistantOptions,
  inferAssistantMode, resolveAssistantMode, isGreetingIntent, assistantGreetingResponse } from './assistant-request';

test('assistant identity is a bounded skin setting, defaults to Nadeem, and cannot be forged by browser text', async () => {
  assert.equal((await resolveAssistantOptions({}, 'owner', 'client')).skin, 'scout');
  assert.equal((await resolveAssistantOptions({ skin: 'classic', characterName: 'admin' }, 'owner', 'client')).skin, 'classic');
  assert.equal('characterName' in assistantOptionsSchema.parse({ characterName: 'admin' }), false);
  assert.equal(assistantOptionsSchema.safeParse({ skin: 'admin' }).success, false);
});

test('web search is optional, preserves explicit booleans and rejects coercion', async () => {
  assert.equal('webSearch' in await resolveAssistantOptions({}, 'owner', 'client'), false);
  for (const webSearch of [true, false]) {
    assert.equal((await resolveAssistantOptions({ webSearch }, 'owner', 'client')).webSearch, webSearch);
  }
  for (const webSearch of ['true', 'false', 1, 0, null, {}]) {
    assert.equal(assistantOptionsSchema.safeParse({ webSearch }).success, false);
  }
});

test('greeting identity follows both skins in every supported dialect', () => {
  for (const skin of ['scout', 'classic'] as const) {
    const arabic = skin === 'scout' ? 'نديم' : 'بيبو';
    const english = skin === 'scout' ? 'Nadeem' : 'Bebo';
    for (const dialect of ['egyptian', 'saudi', 'gulf']) assert.ok(greetingForDialect(dialect, skin)?.includes(arabic));
    assert.ok(greetingForDialect('english', skin)?.includes(english));
    assert.ok(greetingResponseForSkin(skin).includes(arabic));
  }
});

test('ordinary questions default to general knowledge, including questions with a greeting', () => {
  for (const question of ['ما هي عاصمة اليابان؟', 'إزاي أتعلم البرمجة؟', 'أهلاً، اشرح لي الفرق بين React وAngular',
    'السلام عليكم، ممكن تساعدني أخطط لمشروعي؟', 'What is coffee?', 'How does JavaScript work?', 'Hi, tell me about the solar system.']) {
    assert.equal(inferAssistantMode(question), 'general', question);
  }
});

test('animation, charts and quality assurance remain ordinary questions unless tied to platform policy', () => {
  for (const question of ['ازاي أعمل رسوم متحركة؟', 'اشرح الرسوم البيانية', 'ما معنى ضمان الجودة؟', 'Explain quality assurance']) {
    assert.equal(inferAssistantMode(question), 'general', question);
  }
  assert.equal(inferAssistantMode('ما سياسة ضمان الجودة في منصة وسيط؟'), 'policy');
});

test('policy topics stay grounded even if a browser explicitly requests general mode', () => {
  for (const question of ['كام رسوم وسيط؟', 'متى تُفرج أموال الضمان؟', 'إزاي أسحب أرباحي؟', 'كيف أسترد مبلغ الدفع؟',
    'السلام عليكم، متى أفتح نزاع؟', 'ما صلاحيات الإدارة؟', 'سياسات العمولات', 'What are the escrow fees?',
    'What is the refund policy?', 'When can I withdraw my payment?', 'Who decides disputes and permissions?']) {
    assert.equal(inferAssistantMode(question), 'policy', question);
    assert.equal(resolveAssistantMode(question, 'general'), 'policy', question);
  }
  assert.equal(resolveAssistantMode('اشرح JavaScript'), 'general');
  assert.equal(resolveAssistantMode('اشرح JavaScript', 'policy'), 'policy');
});

test('standalone identity works across dialects while identity plus a question reaches AI', () => {
  for (const question of ['انت مين', 'إنت مين؟', 'أنت مين؟', 'انتا مين', 'إنتي مين؟', 'مين أنت؟', 'من أنت؟',
    'منو انت؟', 'وش اسمك؟', 'شنو اسمك؟', 'اسمك إيه؟', 'السلام عليكم، أنت مين؟', 'Who are you?', "What's your name?", 'Hi, who are you?',
    'هو انت مين', 'هو انت مين؟', 'هو انت مين اصلا', 'انت مين بالظبط', 'انت مين بالضبط', 'يسطا', 'يا اسطى', 'يا باشا', 'يا هندسة', 'يا كابتن', 'يا برنس', 'هو انت مين يسطا', 'هو انت مين يا باشا', 'هو انت مين يا هندسة', 'يسطا عامل ايه', 'عامل ايه يا باشا', 'عامل ايه يا هندسة', 'ازيك يا غالي', 'تسلم يا برنس', 'شكرا يا باشا', 'عرفني بنفسك', 'مين معايا', 'السلام عليكم ورحمة الله وبركاته']) {
    assert.equal(isGreetingIntent(question), true, question);
  }
  for (const question of ['انت مين وازاي أكتب مشروع؟', 'أهلاً، ما عاصمة اليابان؟', 'السلام عليكم، كيف يعمل الضمان؟', 'Hi, who are you and how does JavaScript work?', 'هو انت مين وازاي اسحب فلوسي؟']) {
    assert.equal(isGreetingIntent(question), false, question);
  }
  assert.match(assistantGreetingResponse({ skin: 'scout', language: 'en' }), /Nadeem/);
  assert.match(assistantGreetingResponse({ skin: 'classic', dialect: 'egyptian' }), /بيبو/);
});
