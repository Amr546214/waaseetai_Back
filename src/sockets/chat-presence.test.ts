import test from 'node:test';
import assert from 'node:assert/strict';

test('chat presence snapshots, last-tab departure and authorised typing', async t => {
  const invites: unknown[][] = [];
  t.mock.module('../services/notification.service', {
    namedExports: { notificationService: { notifyMeetingRequest: async (...args: unknown[]) => { invites.push(args); } } }
  });
  t.mock.module('../services/chat.service', {
    namedExports: {
      chatService: {},
      resolveActiveRole: async () => 'CLIENT',
      authorizeConversationForRole: async (id: string, userId: string) =>
        id === 'c1' && userId !== 'outsider' ? { id, kind: 'GENERAL', clientId: 'u1', providerId: 'u2' } : null
    }
  });
  const { ChatGateway } = await import('./chat.gateway');
  const { roomNameFor } = await import('../services/project-conversation.service');
  const room = roomNameFor({ id: 'c1' });
  const rooms = new Map<string, Set<string>>();
  const sockets = new Map();
  const gateway = new ChatGateway();
  const messages: Array<{ target: string; event: string; data: any }> = [];
  function make(id: string, userId: string) {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const record = (target: string) => (event: string, data: unknown) => messages.push({ target, event, data });
    const socket = {
      id, userId, connected: true, rooms: new Set<string>(),
      nsp: { adapter: { rooms }, sockets, to: recordRoom },
      on: (event: string, fn: (...args: any[]) => unknown) => handlers.set(event, fn),
      emit: record(id), to: (room: string) => ({ emit: record(room) }),
      join(room: string) {
        if (!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room)!.add(id); this.rooms.add(room);
      },
      leave(room: string) { rooms.get(room)?.delete(id); this.rooms.delete(room); }
    };
    function recordRoom(room: string) { return { emit: record(room) }; }
    sockets.set(id, socket);
    gateway.register(socket as any);
    return { socket, send: async (event: string, body?: any) => handlers.get(event)!(body),
      disconnect() { for (const room of socket.rooms) socket.leave(room); socket.connected = false; return handlers.get('disconnect')!(); } };
  }
  const a = make('a', 'u1'), b = make('b', 'u2'), second = make('a2', 'u1');
  const input = { conversationId: 'c1' };
  await a.send('join_conversation', input);
  await b.send('join_conversation', input);
  assert.ok(messages.some(m => m.target === 'b' && m.event === 'user_online_status' && m.data.userId === 'u1' && m.data.isOnline));
  await second.send('join_conversation', input);
  messages.length = 0;
  await a.disconnect();
  assert.equal(messages.length, 0);
  await second.send('typing_status', { ...input, isTyping: 'false' });
  assert.equal(messages.length, 0);
  await second.send('typing_status', { ...input, userId: 'spoofed', isTyping: true });
  assert.equal(messages[0]?.data.userId, 'u1');
  await second.disconnect();
  assert.ok(messages.some(m => m.target === room && m.event === 'typing_indicator' && m.data.isTyping === false));
  assert.ok(messages.some(m => m.target === room && m.event === 'user_online_status' && m.data.isOnline === false));
  messages.length = 0;
  const stranger = make('other', 'outsider');
  await stranger.send('typing_status', { ...input, isTyping: true });
  await stranger.send('leave_conversation', input);
  assert.equal(messages.length, 0);
  const call = { ...input, offer: { type: 'offer', sdp: 'v=0' }, callerId: 'spoofed', recipientId: 'outsider' };
  await stranger.send('call_user', call);
  await b.send('call_user', { ...call, offer: { type: 'answer', sdp: 'v=0' } });
  assert.equal(invites.length, 0);
  const caller = make('new-a', 'u1');
  await caller.send('call_user', call);
  assert.deepEqual(invites, [['u2', 'u1', 'c1', '/provider-overview/messages?conversationId=c1']]);
  assert.equal(messages.find(m => m.event === 'incoming_call')?.data.callerId, 'u1');
});
