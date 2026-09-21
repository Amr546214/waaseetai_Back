import { test, TestContext } from 'node:test';
import assert from 'node:assert/strict';

// Role isolation for chat: a multi-role user (roles: [CLIENT, PROVIDER]) must
// see/access/send/read only the conversations that belong to their CURRENT
// activeRole. Before this fix, every chat.service query authorized access
// with `OR: [{clientId: userId}, {providerId: userId}]`, which is role-blind
// — this fixture reproduces exactly the reported bug scenario: the same
// User.id participates as CLIENT in one conversation and as PROVIDER in
// another.

function buildFixture() {
  const conversations: any[] = [
    {
      id: 'conv-as-client',
      projectId: 'proj-1',
      offerId: null,
      clientId: 'user-multi',
      providerId: 'provider-other',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z')
    },
    {
      id: 'conv-as-provider',
      projectId: 'proj-2',
      offerId: null,
      clientId: 'client-other',
      providerId: 'user-multi',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z')
    }
  ];

  const messages: any[] = [
    {
      id: 'msg-1',
      conversationId: 'conv-as-client',
      senderId: 'provider-other',
      type: 'TEXT',
      content: 'hello client',
      status: 'SENT',
      createdAt: new Date('2026-01-01T01:00:00Z'),
      sender: { id: 'provider-other', firstName: 'Provider', lastName: 'Other', avatarUrl: null }
    },
    {
      id: 'msg-2',
      conversationId: 'conv-as-provider',
      senderId: 'client-other',
      type: 'TEXT',
      content: 'hello provider',
      status: 'SENT',
      createdAt: new Date('2026-01-02T01:00:00Z'),
      sender: { id: 'client-other', firstName: 'Client', lastName: 'Other', avatarUrl: null }
    }
  ];

  const users: Record<string, any> = {
    'user-multi': { id: 'user-multi', activeRole: 'CLIENT' },
    'provider-other': { id: 'provider-other', activeRole: 'PROVIDER' },
    'client-other': { id: 'client-other', activeRole: 'CLIENT' }
  };

  const matchesWhere = (conv: any, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, value]) => {
      if (key === 'id') return conv.id === value;
      if (key === 'clientId') return conv.clientId === value;
      if (key === 'providerId') return conv.providerId === value;
      return true;
    });
  };

  const prismaMock: any = {
    user: {
      findUnique: async ({ where }: any) => {
        const u = users[where.id];
        return u ? { ...u } : null;
      }
    },
    conversation: {
      findMany: async ({ where }: any) =>
        conversations
          .filter((c) => matchesWhere(c, where))
          .map((c) => ({
            ...c,
            project: { title: 'Test Project', specialty: null, budgetMin: null, budgetMax: null, budgetFixed: null },
            client: { id: c.clientId, firstName: 'Client', lastName: 'User', avatarUrl: null, accountType: 'CLIENT_INDIVIDUAL' },
            provider: { id: c.providerId, firstName: 'Provider', lastName: 'User', avatarUrl: null, accountType: 'PROVIDER_INDIVIDUAL', providerProfile: null },
            messages: messages.filter((m) => m.conversationId === c.id),
            _count: { messages: messages.filter((m) => m.conversationId === c.id && m.senderId !== where.clientId && m.senderId !== where.providerId && m.status !== 'READ').length }
          })),
      findFirst: async ({ where }: any) => {
        const found = conversations.find((c) => matchesWhere(c, where));
        return found ? { ...found } : null;
      },
      findUnique: async ({ where }: any) => {
        const found = conversations.find((c) => c.id === where.id);
        return found ? { ...found } : null;
      },
      update: async ({ where, data }: any) => {
        const c = conversations.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
      }
    },
    message: {
      create: async ({ data }: any) => {
        const msg = { ...data, id: `msg-${messages.length + 1}`, createdAt: new Date(), sender: { id: data.senderId, firstName: 'X', lastName: 'Y', avatarUrl: null } };
        messages.push(msg);
        return msg;
      },
      findMany: async ({ where }: any) => messages.filter((m) => m.conversationId === where.conversationId),
      count: async ({ where }: any) => messages.filter((m) => m.conversationId === where.conversationId).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        messages.forEach((m) => {
          if (m.conversationId === where.conversationId && m.senderId !== where.senderId?.not && m.status !== data.status) {
            m.status = data.status;
            count++;
          }
        });
        return { count };
      }
    },
    notification: {
      create: async () => ({})
    }
  };

  return { prismaMock, conversations, messages, users };
}

async function loadServiceWithFixture(t: TestContext) {
  const fixture = buildFixture();
  t.mock.module('../config/db', { namedExports: { prisma: fixture.prismaMock } });
  const moduleUrl = `./chat.service.ts?fixture=${Date.now()}-${Math.random()}`;
  const mod = await import(moduleUrl);
  return { ...fixture, ...mod };
}

test('getConversations: CLIENT activeRole sees only conversations where the user is clientId', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const result = await chatService.getConversations('user-multi', 'CLIENT');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'conv-as-client');
});

test('getConversations: PROVIDER activeRole sees only conversations where the user is providerId', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const result = await chatService.getConversations('user-multi', 'PROVIDER');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'conv-as-provider');
});

test('getConversations: AFFILIATE (or any non-CLIENT/PROVIDER role) sees an empty inbox, never the union of both', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const result = await chatService.getConversations('user-multi', 'AFFILIATE');
  assert.deepEqual(result, []);
});

test('getConversations: single-role user behavior is unchanged', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  // client-other is the fixed clientId on conv-as-provider (a single-role
  // counterpart in this fixture) — confirms the role filter still correctly
  // returns a user's own conversation, not just multi-role users.
  const asClient = await chatService.getConversations('client-other', 'CLIENT');
  assert.equal(asClient.length, 1);
  assert.equal(asClient[0].id, 'conv-as-provider');
});

test('getMessages: CLIENT can read history for their own CLIENT conversation', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const result = await chatService.getMessages('conv-as-client', 'user-multi', 1, 20, 'CLIENT');
  assert.equal(result.data.length, 1);
});

test('getMessages: CLIENT session CANNOT read history for the same User.id\'s PROVIDER conversation', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  await assert.rejects(
    () => chatService.getMessages('conv-as-provider', 'user-multi', 1, 20, 'CLIENT'),
    /403|غير مصرح/
  );
});

test('getMessages: PROVIDER session CANNOT read history for the same User.id\'s CLIENT conversation', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  await assert.rejects(
    () => chatService.getMessages('conv-as-client', 'user-multi', 1, 20, 'PROVIDER'),
    /403|غير مصرح/
  );
});

test('sendMessage: CLIENT can send into their own CLIENT conversation', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const result = await chatService.sendMessage('user-multi', { conversationId: 'conv-as-client', content: 'hi', type: 'TEXT' }, 'CLIENT');
  assert.equal(result.message.text, 'hi');
  assert.equal(result.recipientId, 'provider-other');
});

test('sendMessage: CLIENT session CANNOT send into the same User.id\'s PROVIDER conversation', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  await assert.rejects(
    () => chatService.sendMessage('user-multi', { conversationId: 'conv-as-provider', content: 'hi', type: 'TEXT' }, 'CLIENT'),
    /403|غير مصرح/
  );
});

test('sendMessage: PROVIDER session CANNOT send into the same User.id\'s CLIENT conversation', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  await assert.rejects(
    () => chatService.sendMessage('user-multi', { conversationId: 'conv-as-client', content: 'hi', type: 'TEXT' }, 'PROVIDER'),
    /403|غير مصرح/
  );
});

test('markAsRead: CLIENT can mark their own CLIENT conversation as read', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const result = await chatService.markAsRead('conv-as-client', 'user-multi', 'CLIENT');
  assert.equal(result.success, true);
});

test('markAsRead: CLIENT session CANNOT mark the same User.id\'s PROVIDER conversation as read', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  await assert.rejects(
    () => chatService.markAsRead('conv-as-provider', 'user-multi', 'CLIENT'),
    /403|غير مصرح/
  );
});

test('authorizeConversationForRole: denies joining the Socket.IO room for the inactive role\'s conversation (CLIENT -> PROVIDER conversation)', async (t) => {
  const { authorizeConversationForRole } = await loadServiceWithFixture(t);
  const result = await authorizeConversationForRole('conv-as-provider', 'user-multi', 'CLIENT');
  assert.equal(result, null);
});

test('authorizeConversationForRole: denies joining the Socket.IO room for the inactive role\'s conversation (PROVIDER -> CLIENT conversation)', async (t) => {
  const { authorizeConversationForRole } = await loadServiceWithFixture(t);
  const result = await authorizeConversationForRole('conv-as-client', 'user-multi', 'PROVIDER');
  assert.equal(result, null);
});

test('authorizeConversationForRole: allows joining the room that matches the active role', async (t) => {
  const { authorizeConversationForRole } = await loadServiceWithFixture(t);
  const asClient = await authorizeConversationForRole('conv-as-client', 'user-multi', 'CLIENT');
  assert.equal(asClient?.id, 'conv-as-client');
  const asProvider = await authorizeConversationForRole('conv-as-provider', 'user-multi', 'PROVIDER');
  assert.equal(asProvider?.id, 'conv-as-provider');
});

test('resolveActiveRole: resolves the role fresh from the database by userId', async (t) => {
  const { resolveActiveRole } = await loadServiceWithFixture(t);
  assert.equal(await resolveActiveRole('user-multi'), 'CLIENT');
  assert.equal(await resolveActiveRole('provider-other'), 'PROVIDER');
});

test('unread counts: getConversations only counts unread messages within role-isolated conversations', async (t) => {
  const { chatService } = await loadServiceWithFixture(t);
  const asClient = await chatService.getConversations('user-multi', 'CLIENT');
  // conv-as-client has 1 unread message from provider-other
  assert.equal(asClient[0].unreadCount, 1);

  const asProvider = await chatService.getConversations('user-multi', 'PROVIDER');
  // conv-as-provider has 1 unread message from client-other
  assert.equal(asProvider[0].unreadCount, 1);
});
