import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Batch B / T5: structural guards on the notification producers (the behaviour itself is proven in pg-notifications-ratings-t5.pg.test.ts). */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a chat message notification goes through NotificationService (stored AND delivered per the recipient\'s channels), never a bare insert', () => {
	const src = read('../sockets/chat.gateway.ts');
	assert.doesNotMatch(src, /prisma\.notification\.create/);
	assert.match(src, /notificationService\.createAndEmit\(/);
	assert.match(src, /type: 'CHAT'/);
});

test('the amendment answers use the safe client sender: a failing notification cannot turn a committed answer into an error', () => {
	const src = read('./project-amendment.service.ts');
	assert.doesNotMatch(src, /prisma\.notification\.create/);
	assert.equal((src.match(/clientNotifications\.send\(clientNotificationFor\.amendmentAnswered/g) ?? []).length, 2);
});

test('the dead, preference-ignoring `notification_received` socket event is gone from the proposal flow (the stored notification is delivered once, per channels)', () => {
	assert.doesNotMatch(read('./proposal.service.ts'), /notification_received/);
});

test('the notification list is only ever read for the caller (userId in the WHERE) and supports the recovery parameters', () => {
	const svc = read('./notification.service.ts');
	assert.match(svc, /where: \{\s*userId,/);
	assert.match(svc, /createdAt: \{ gte: options\.since \}/);
	assert.match(read('../controllers/notifications.controller.ts'), /unreadCount: await notificationService\.countUnread\(userId\)/);
});

test('every socket room a notification is emitted to is the recipient\'s own personal room', () => {
	const svc = read('./notification.service.ts');
	assert.match(svc, /io\.to\(`user_\$\{dto\.userId\}`\)\.to\(`project_owner_\$\{dto\.userId\}`\)\.emit\('new_notification', dto\)/);
	assert.doesNotMatch(svc, /io\.emit\(/);
});
