import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';

let state: any;
let gate: Promise<unknown> = Promise.resolve();
const db: any = {
  supportTicket: { findUnique: async ({ where }: any) => state.tickets.find((r: any) => Object.entries(where).every(([k,v]) => r[k] === v)) ?? null,
    update: async ({ where, data }: any) => Object.assign(state.tickets.find((r: any) => matches(r, where)), data),
    create: async ({ data }: any) => {
      if (state.failDb) throw new Error('database unavailable');
      if (data.submissionKey && state.tickets.some((r: any) => r.submissionKey === data.submissionKey)) throw Object.assign(new Error('unique'), { code: 'P2002' });
      assert.ok(data.messages.create.body); // one nested write owns the ticket + original message + attachments
      const { messages, attachments, ...fields } = data;
      const row = { ...fields, id: randomUUID() }; state.tickets.push(row);
      (attachments?.create || []).forEach((f: any) => state.files.push({ ...f, id: randomUUID(), ticketId: row.id }));
      state.messages.push({ ...messages.create, ticketId: row.id }); return row;
    } },
  supportTicketMessage: {
    findUnique: async ({ where }: any) => state.messages.find((r: any) => matches(r, where)) ?? null,
    create: async ({ data }: any) => { const row = { ...data, id: randomUUID(), createdAt: new Date() }; state.messages.push(row); return row; },
  },
  accountAuditLog: { create: async ({ data }: any) => data },
  dispute: { findUnique: async ({ where }: any) => state.disputes.find((r: any) => r.id === where.id) ?? null },
  caseAttachment: {
    findMany: async ({ where, select }: any) => state.files.filter((r: any) => matches(r, where)).map((r: any) => select ? Object.fromEntries(Object.keys(select).map(k => [k, r[k]])) : r),
    findFirst: async ({ where }: any) => state.files.find((r: any) => matches(r, where)) ?? null,
    count: async ({ where }: any) => state.files.filter((r: any) => matches(r, where)).length,
    createMany: async ({ data }: any) => { if (state.failDb) throw new Error('database unavailable'); state.files.push(...data); return { count: data.length }; },
  },
  user: { findUnique: async () => ({ accountType: 'PROVIDER_INDIVIDUAL' }) },
  adminStaff: { findUnique: async () => state.staff },
  $queryRaw: async (strings: any, id: string) => { assert.match(strings.join('?'), /FOR UPDATE/); if (state.closeAtLock) state.disputes[0].status = 'RESOLVED'; return [{ id }]; },
  $transaction: async (fn: any) => {
    const previous = gate; let release!: () => void; gate = new Promise<void>(r => { release = r; });
    await previous;
    const messages = [...state.messages], files = [...state.files];
    try { return await fn(db); } catch (error) { state.messages = messages; state.files = files; throw error; } finally { release(); }
  },
};
function matches(row: any, where: any) { return Object.entries(where).every(([k,v]) => row[k] === v); }
let service: typeof import('./case-attachments.service');
let supportTicketService: typeof import('./support-ticket.service')['supportTicketService'];
let requirePermission: typeof import('../middlewares/admin-access.middleware')['requirePermission'];
let caseAttachmentsRouter: typeof import('../routes/case-attachments.routes')['caseAttachmentsRouter'];
before(async () => {
mock.module('../config/db', { namedExports: { prisma: db } });
const storage = await import('../utils/cloudinary-storage');
mock.module('../utils/cloudinary-storage', { namedExports: {
  // Real multer and upload limiter are tested in the HTTP test below; storage is explicitly mocked.
  memoryUpload: storage.memoryUpload,
  uploadMulterFile: async (file: any, folder: string, max: number, privateFile: boolean) => {
    assert.equal(privateFile, true); assert.equal(max, 10485760); assert.match(folder, /^case-files\//);
    if (state.uploads.length === state.failUploadAt) throw new Error('storage unavailable');
    const publicId = randomUUID(); state.uploads.push(publicId);
    return { publicId, privateRef: `private:image:pdf:${publicId}`, mimeType: file.mimetype, bytes: file.buffer.length, resourceType: 'image' };
  },
  deleteCloudFile: async (id: string, type: string, privateFile: boolean) => { assert.equal(privateFile, true); state.deleted.push(id); },
  createPrivateDownloadUrl: (ref: string, ttl: number) => { assert.equal(ttl, 60); return { url: `https://files.example.test/${encodeURIComponent(ref)}`, expiresAt: 123 }; },
} });
mock.module('./notification.service', { namedExports: { notificationService: { createAndEmit: async () => null } } });
mock.module('./admin-notifications.service', { namedExports: { notifyAdmins: async () => {} } });
service = await import('./case-attachments.service');
({ supportTicketService } = await import('./support-ticket.service'));
({ caseAttachmentsRouter } = await import('../routes/case-attachments.routes'));
({ requirePermission } = await import('../middlewares/admin-access.middleware'));

});

beforeEach(() => {
  state = { tickets: [{ id: 't1', userId: 'owner' }], disputes: [{ id: 'd1', openedById: 'owner', againstUserId: 'party', status: 'OPEN', evidence: ['old-proof'] }], files: [], messages: [], uploads: [], deleted: [], failUploadAt: -1 };
  gate = Promise.resolve();
});
const file = (name = 'proof.pdf', bytes = Buffer.from('%PDF-1.4\nproof')) => ({ originalname: name, mimetype: 'application/pdf', buffer: bytes, size: bytes.length }) as Express.Multer.File;
const ticketInput = () => ({ subject: 'مشكلة في الحساب', category: 'دعم', description: 'وصف تفصيلي كاف لمشكلة الحساب', submissionKey: randomUUID() });

test('validates bytes, rejects forged MIME, markup, empty, oversized and too many files before any storage call', () => {
  service.validateCaseFiles([file()]);
  for (const files of [[file('bad.pdf', Buffer.from('not pdf'))], [file('bad.pdf', Buffer.from('<svg/>'))], [file('empty.pdf', Buffer.alloc(0))], [file('big.pdf', Buffer.alloc(10485761))], Array(6).fill(file()), [{ ...file(), mimetype: 'image/svg+xml' }]]) assert.throws(() => service.validateCaseFiles(files));
  assert.equal(state.uploads.length, 0);
});
test('placeholder local-dev storage is refused rather than reporting a fake upload', async () => {
  const old = process.env.CLOUDINARY_CLOUD_NAME; process.env.CLOUDINARY_CLOUD_NAME = 'local-dev';
  try { await assert.rejects(service.storeCaseFiles([file()], 'owner'), (e: any) => e.statusCode === 503); } finally { if (old === undefined) delete process.env.CLOUDINARY_CLOUD_NAME; else process.env.CLOUDINARY_CLOUD_NAME = old; }
});
test('storage failure cleans earlier private files and creates no ticket', async () => {
  state.failUploadAt = 1;
  await assert.rejects(supportTicketService.create('owner', ticketInput(), [file(), file('second.pdf')]));
  assert.deepEqual(state.deleted, state.uploads); assert.equal(state.tickets.length, 1); assert.equal(state.messages.length, 0);
});
test('ticket creation binds the files and original message atomically; same-key retry creates nothing twice', async () => {
  const input = ticketInput(); const first = await supportTicketService.create('owner', input, [file()]);
  const second = await supportTicketService.create('owner', input, [file()]);
  assert.equal(first.id, second.id); assert.equal(state.files.length, 1); assert.equal(state.messages.length, 1); assert.equal(state.uploads.length, 1);
  assert.equal(state.files[0].ticketId, first.id);
  await assert.rejects(supportTicketService.create('owner', { ...input, subject: 'بيانات مختلفة' }, [file()]), (e: any) => e.statusCode === 409);
  await assert.rejects(supportTicketService.create('other', input, [file()]), (e: any) => e.statusCode === 409);
});
test('database failure cleans ticket uploads and leaves no apparent success', async () => {
  state.failDb = true; await assert.rejects(supportTicketService.create('owner', ticketInput(), [file()]));
  assert.deepEqual(state.deleted, state.uploads); assert.equal(state.files.length, 0); assert.equal(state.messages.length, 0);
});
test('owner and both dispute parties can read; other users and missing parents get indistinguishable 404', async () => {
  await service.assertCaseAccess('ticket', 't1', 'owner', false);
  for (const id of ['owner','party']) await service.assertCaseAccess('dispute', 'd1', id, false);
  await service.assertCaseAccess('ticket', 't1', 'staff', true);
  for (const call of [() => service.assertCaseAccess('ticket','t1','other',false), () => service.assertCaseAccess('ticket','missing','other',false), () => service.assertCaseAccess('dispute','d1','other',false)]) await assert.rejects(call, (e: any) => e.statusCode === 404);
});
test('concurrent retry under the row lock creates one batch, keeps old evidence and cleans redundant uploads', async () => {
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => service.appendDisputeFiles('d1','party',[file()],key)));
  assert.equal(state.files.length, 1); assert.equal(state.deleted.length, 4); assert.equal(results[0][0].id, results[4][0].id);
  assert.deepEqual(state.disputes[0].evidence, ['old-proof']);
  await assert.rejects(service.appendDisputeFiles('d1','party',[file('changed.pdf')],key), (e: any) => e.statusCode === 409);
  assert.equal(state.files.length, 1);
});
test('closure during storage or a full evidence list refuses the append and removes the uploaded batch', async () => {
  state.closeAtLock = true;
  await assert.rejects(service.appendDisputeFiles('d1','owner',[file()],randomUUID()), (e: any) => e.statusCode === 409);
  assert.equal(state.files.length, 0); assert.deepEqual(state.deleted, state.uploads);
  state.closeAtLock = false; state.disputes[0].status = 'OPEN'; state.disputes[0].evidence = Array(20).fill('old');
  await assert.rejects(service.appendDisputeFiles('d1','owner',[file()],randomUUID()), (e: any) => e.statusCode === 409);
  assert.equal(state.files.length, 0); assert.deepEqual(state.deleted, state.uploads);
});
test('closed disputes and outsiders fail before storage; metadata contains no storage refs and download is parent-bound', async () => {
  state.disputes[0].status = 'RESOLVED';
  await assert.rejects(service.appendDisputeFiles('d1','owner',[file()],randomUUID()), (e: any) => e.statusCode === 409);
  state.disputes[0].status = 'OPEN';
  await assert.rejects(service.appendDisputeFiles('d1','other',[file()],randomUUID()), (e: any) => e.statusCode === 404);
  assert.equal(state.uploads.length, 0);
  await service.appendDisputeFiles('d1','owner',[file()],randomUUID());
  const rows = await service.listCaseFiles('dispute','d1'); assert.equal('privateRef' in rows[0], false);
  assert.equal('requestKey' in rows[0], false); assert.equal('digest' in rows[0], false);
  await assert.rejects(service.downloadCaseFile('ticket','t1',rows[0].id), (e: any) => e.statusCode === 404);
  assert.match((await service.downloadCaseFile('dispute','d1',rows[0].id)).url, /^https:/);
});
test('HTTP parent scoping: metadata/download require the owning case, no-store, and a multipart append returns saved metadata only', async t => {
  const app = express();
  app.use((req, _res, next) => { (req as any).user = { id: req.headers['x-test-user'] || 'owner' }; next(); });
  app.use('/disputes/:id/attachments', caseAttachmentsRouter('dispute'));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as any).port}/disputes/d1/attachments`;
  assert.equal((await fetch(base, { headers: { 'x-test-user': 'other' } })).status, 404);
  const body = new FormData(); body.append('requestKey', randomUUID()); body.append('attachments', new Blob([file().buffer], {type:'application/pdf'}), 'proof.pdf');
  const response = await fetch(base, {method:'POST',body}); assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'),'no-store');
  const result = await response.json() as any; assert.equal(result.data.length,1); assert.equal('privateRef' in result.data[0],false);
  assert.equal((await fetch(`${base}/${result.data[0].id}/download`, {headers:{'x-test-user':'other'}})).status,404);
  assert.equal((await fetch(`${base}/${result.data[0].id}/download`)).status,200);
});

// Real permission middleware and file routes; identity is an explicit local header fixture, not JWT authentication.
test('HTTP staff files require current support.review/disputes.view; revocation applies on the next request', async t => {
  const app = express();
  app.use((req: any, res, next) => {
    if (!req.headers['x-test-user']) return res.status(401).json({success:false});
    req.user={id:req.headers['x-test-user'],userId:req.headers['x-test-user'],accountType:req.headers['x-test-type'] || 'ADMIN'}; next();
  });
  app.use('/admin/tickets/:id/attachments',requirePermission('support.review'),caseAttachmentsRouter('ticket',true));
  app.use('/admin/disputes/:id/attachments',requirePermission('disputes.view'),caseAttachmentsRouter('dispute',true));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({message:err.message}));
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const get=(path: string, type='ADMIN')=>fetch(base+path,{headers:{'x-test-user':'staff','x-test-type':type}});
  assert.equal((await fetch(base+'/admin/tickets/t1/attachments')).status,401);
  assert.equal((await get('/admin/tickets/t1/attachments')).status,403);
  assert.equal((await get('/admin/tickets/t1/attachments','CLIENT_INDIVIDUAL')).status,403);
  state.staff={id:'s',status:'ACTIVE',roleId:'r',scoped:false,departments:[],overrides:[],role:{id:'r',name:'Support',permissions:['support.review']}};
  assert.equal((await get('/admin/tickets/t1/attachments')).status,200);
  assert.equal((await get('/admin/disputes/d1/attachments')).status,403);
  state.staff.role.permissions=['disputes.view'];
  assert.equal((await get('/admin/disputes/d1/attachments')).status,200);
  assert.equal((await get('/admin/tickets/t1/attachments')).status,403);
  state.staff.role.permissions=[];
  assert.equal((await get('/admin/disputes/d1/attachments')).status,403);
  assert.equal((await get('/admin/disputes/d1/attachments','SUPER_ADMIN')).status,200);
});

test('concurrent ticket retries create one nested ticket/message/file set and clean losing uploads', async () => {
  const input=ticketInput();
  const result=await Promise.all(Array.from({length:4},()=>supportTicketService.create('owner',input,[file()])));
  assert.equal(new Set(result.map(t=>t.id)).size,1); assert.equal(state.tickets.length,2);
  assert.equal(state.files.length,1); assert.equal(state.messages.length,1); assert.equal(state.deleted.length,3);
});

test('HTTP multipart ticket creation binds actual bytes; forged content never creates a ticket', async t => {
  const {createTicket}=await import('../controllers/support-ticket.controller');
  const {caseFilesUpload}=await import('../routes/case-attachments.routes');
  const {globalErrorHandler}=await import('../middlewares/error.middleware');
  const app=express(); app.use(express.json());
  app.use((req,_res,next)=>{(req as any).user={id:'owner',userId:'owner'};next();});
  app.post('/tickets',caseFilesUpload,createTicket);
  app.use('/tickets/:id/attachments',caseAttachmentsRouter('ticket'));
  app.use(globalErrorHandler as any);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const base=`http://127.0.0.1:${(server.address() as any).port}/tickets`;
  const send=async (bytes: string, input=ticketInput())=>{
    const body=new FormData();Object.entries(input).forEach(([k,v])=>body.append(k,v));
    body.append('attachments',new Blob([bytes],{type:'application/pdf'}),'دليل.pdf');
    return fetch(base,{method:'POST',body});
  };
  assert.equal((await send('this is not a PDF')).status,415);assert.equal(state.tickets.length,1);
  const res=await send('%PDF-1.4\nactual file bytes');assert.equal(res.status,201);
  const data=(await res.json() as any).data;
  assert.equal(state.messages.length,1); assert.equal(state.files[0].ticketId,data.id);
  const list=await fetch(`${base}/${data.id}/attachments`);const rows=(await list.json() as any).data;
  assert.equal(rows[0].name,'دليل.pdf');assert.equal('privateRef' in rows[0],false);
});

test('OpenAPI preserves nested case paths and documents real multipart fields, without replacing the ticket list path', async () => {
  const {mountCaseAttachments}=await import('../routes/case-attachments.routes');
  const {createOpenApiDocument}=await import('../config/swagger');
  const app=express(), router=express.Router();router.get('/tickets',(_q,r)=>r.json({}));router.post('/tickets',(_q,r)=>r.json({}));
  mountCaseAttachments(router,'/tickets/:id/attachments','ticket');
  mountCaseAttachments(router,'/disputes/:id/attachments','dispute');
  app.use('/api/provider',router);(app.router.stack.at(-1) as any).__swaggerPath='/api/provider';
  const paths=createOpenApiDocument(app).paths as any;
  assert.ok(paths['/api/provider/tickets'].get);
  assert.ok(paths['/api/provider/tickets/:id/attachments'].get);
  assert.ok(paths['/api/provider/tickets/:id/attachments/:attachmentId/download'].get);
  assert.ok(paths['/api/provider/disputes/:id/attachments'].post.requestBody.content['multipart/form-data'].schema.required.includes('requestKey'));
  assert.ok(paths['/api/provider/tickets'].post.requestBody.content['application/json']);
});

test('staff reply files belong to the saved message and a retry sends only once', async () => {
  state.tickets[0].status = 'OPEN';
  const key = randomUUID();
  const first = await supportTicketService.replyAsStaff('t1', 'staff', 'رد مع مرفق', undefined, [file()], key);
  const second = await supportTicketService.replyAsStaff('t1', 'staff', 'رد مع مرفق', undefined, [file()], key);
  assert.equal(first.message.id, second.message.id);
  assert.equal(state.messages.length, 1);
  assert.equal(state.files.length, 1);
  assert.equal(state.files[0].messageId, first.message.id);
  assert.equal(state.files[0].ticketId, 't1');
  assert.equal(state.deleted.length, 1);
  assert.equal('replyDigest' in first.message, false);
  const files = await service.listCaseFiles('ticket', 't1');
  assert.equal(files[0].messageId, first.message.id);
  assert.equal('privateRef' in files[0], false);
});

test('staff reply file persistence failure rolls back the message and removes the uploaded object', async () => {
  state.tickets[0].status = 'OPEN';
  state.failDb = true;
  await assert.rejects(supportTicketService.replyAsStaff('t1', 'staff', 'رد مع مرفق', undefined, [file()], randomUUID()));
  assert.equal(state.messages.length, 0);
  assert.equal(state.files.length, 0);
  assert.equal(state.deleted.length, 1);
});
