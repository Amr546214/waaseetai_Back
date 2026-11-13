import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESTORE_PHRASE } from './admin-infrastructure.routes';

test('the restore confirmation phrase is fixed and Arabic (typed, not a checkbox)', () => { assert.equal(RESTORE_PHRASE, 'أؤكد طلب الاستعادة'); });
