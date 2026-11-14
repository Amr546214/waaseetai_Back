import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** REAL PostgreSQL (isolated local database only, synthetic data): a revision request becomes a message of the project room, and the provider's answer is stored as a REPLY quoting it. */
const URL = process.env.QA_ISOLATED_PG_URL;
const enabled = !!URL && URL === process.env.DATABASE_URL && /@(127\.0\.0\.1|localhost):55432\//.test(URL);
const opts = { skip: enabled ? false : 'set QA_ISOLATED_PG_URL (isolated local PostgreSQL on :55432) to run' };

test('pg: revision request -> room message (idempotent) -> provider reply is quoted; foreign / system / unknown targets are never quoted; the quote cannot be forged', opts, async () => {
	const { prisma } = await import('../config/db'); const { projectProgressService } = await import('./project-progress.service'); const { chatService } = await import('./chat.service'); const { ensureProjectRoom } = await import('./project-conversation.service');
	const id = () => randomUUID(); const tag = id().slice(0, 8);
	const mk = (accountType: string, role: string, n: string) => prisma.user.create({ data: { id: id(), accountType: accountType as any, firstName: 'QA', lastName: n, email: `qa-${n}-${tag}@pg.test`, roles: [role] as any, activeRole: role as any, status: 'ACTIVE' } });
	const client = await mk('CLIENT_INDIVIDUAL', 'CLIENT', 'client'), provider = await mk('PROVIDER_INDIVIDUAL', 'PROVIDER', 'prov');
	const project = await prisma.project.create({ data: { id: id(), title: `QA reply ${tag}`, description: 'synthetic', specialty: 'x', deliveryDays: 10, clientId: client.id, providerId: provider.id, status: 'IN_PROGRESS' } });
	const contract = await prisma.contract.create({ data: { id: id(), projectId: project.id, clientId: client.id, providerId: provider.id, price: 20, durationDays: 14, phasesCount: 1, status: 'ACTIVE', signedAt: new Date() } });
	await prisma.escrow.create({ data: { id: id(), projectId: project.id, amount: 20, status: 'HELD' } });
	const stage = await prisma.projectStage.create({ data: { id: id(), contractId: contract.id, stepOrder: 1, title: 'تصميم الشعار', days: 7, percentage: 100, amount: 20, status: 'SUBMITTED' } });
	const delivery = await prisma.stageDelivery.create({ data: { id: id(), stageId: stage.id, providerId: provider.id, note: 'synthetic delivery note', status: 'SUBMITTED' } });
	const room = await ensureProjectRoom(prisma, { id: contract.id, projectId: project.id, clientId: client.id, providerId: provider.id });
	const NOTE = 'الصورة غير مناسبة، أرجو تغييرها';
	await projectProgressService.reviewDelivery(client.id, contract.id, stage.id, 'revision', NOTE);
	let msgs = await prisma.message.findMany({ where: { conversationId: room.id, eventKey: { startsWith: 'revision:' } } });
	assert.equal(msgs.length, 1); const req = msgs[0]; assert.equal(req.senderId, client.id); assert.equal(req.type, 'TEXT'); assert.match(req.content!, /طلب تعديل على «تصميم الشعار»/); assert.ok(req.content!.includes(NOTE));
	assert.deepEqual({ kind: (req.context as any).kind, stageId: (req.context as any).stageId, deliveryId: (req.context as any).deliveryId }, { kind: 'REVISION_REQUEST', stageId: stage.id, deliveryId: delivery.id });
	// the workspace (project page) lists it with its context
	const ws: any = await projectProgressService.getProjectProgress(client.id, project.id); assert.equal(ws.messages.find((m: any) => m.id === req.id)?.context?.kind, 'REVISION_REQUEST');
	// idempotent: the same delivery never gets a second message
	const { postRevisionRequestMessage } = await import('./project-conversation.service');
	assert.equal((await postRevisionRequestMessage({ contractId: contract.id, clientId: client.id, stageId: stage.id, stageTitle: 'x', deliveryId: delivery.id, note: 'again again again' })).created, false);
	// the provider answers: stored as a reply, the quote is rebuilt from the real message (a forged quote is ignored)
	const replyRes: any = await chatService.sendMessage(provider.id, { conversationId: room.id, content: 'ماشي، سأعدّلها', type: 'TEXT', context: { type: 'PROJECT', replyTo: { messageId: req.id, senderName: 'مزوّر', excerpt: 'نص مزوّر' } } } as any, 'PROVIDER'); const reply = replyRes.message;
	const stored = await prisma.message.findUnique({ where: { id: reply.id } }); const rt = (stored!.context as any).replyTo;
	assert.equal(rt.messageId, req.id); assert.equal(rt.senderId, client.id); assert.equal(rt.kind, 'REVISION_REQUEST'); assert.ok(rt.excerpt.includes(NOTE)); assert.notEqual(rt.senderName, 'مزوّر'); assert.notEqual(rt.excerpt, 'نص مزوّر');
	assert.equal(reply.context?.replyTo?.messageId, req.id, 'the sent message carries it back to the sender / room');
	// unknown / foreign / system targets are dropped, the message is still sent
	const other = await prisma.conversation.create({ data: { id: id(), clientId: client.id, providerId: provider.id, projectId: null, kind: 'GENERAL' } as any }).catch(() => null);
	const foreign = other ? await prisma.message.create({ data: { conversationId: other.id, senderId: client.id, content: 'other room', type: 'TEXT' } }) : null;
	const sys = await prisma.message.create({ data: { conversationId: room.id, senderId: client.id, content: 'system', type: 'SYSTEM', eventKey: `sys:${tag}` } });
	for (const target of [randomUUID(), foreign?.id ?? randomUUID(), sys.id]) {
		const rr: any = await chatService.sendMessage(provider.id, { conversationId: room.id, content: `رد على ${target.slice(0, 4)}`, type: 'TEXT', context: { type: 'PROJECT', replyTo: { messageId: target } } } as any, 'PROVIDER'); const r = rr.message;
		assert.equal((await prisma.message.findUnique({ where: { id: r.id } }))!.context && ((await prisma.message.findUnique({ where: { id: r.id } }))!.context as any).replyTo, undefined, `target ${target.slice(0, 4)} is not quoted`);
	}
});
