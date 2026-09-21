import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateConversationDto, SendMessageDto } from '../dtos/chat.dto';
import { MessageType, MessageStatus, UserRole } from '@prisma/client';

/**
 * Single source of truth for CLIENT/PROVIDER chat role isolation.
 *
 * Conversation has no role column — a user's role IN a given conversation is
 * whichever fixed column (clientId/providerId) matches their User.id. This
 * maps the user's CURRENT activeRole to the one column that role is allowed
 * to touch. AFFILIATE (and anything else) deliberately returns null: there is
 * no AFFILIATE participation concept on Conversation yet — see the follow-up
 * architecture task instead of inventing a mapping here.
 *
 * activeRole must always come from a trusted, DB-resolved source, never from
 * a frontend-supplied body/query param:
 * - HTTP callers pass req.user.activeRole (the authenticate middleware
 *   re-reads this from the DB on every request).
 * - Socket.IO callers must call resolveActiveRole() below per-event, since a
 *   long-lived socket connection can outlive a role switch made elsewhere.
 */
export function conversationRoleFilter(
  userId: string,
  activeRole: UserRole | string | null | undefined
): { clientId: string } | { providerId: string } | null {
  if (activeRole === UserRole.CLIENT) return { clientId: userId };
  if (activeRole === UserRole.PROVIDER) return { providerId: userId };
  return null;
}

/**
 * Resolves a user's CURRENT activeRole directly from the database. Used by
 * Socket.IO handlers, which only learn a userId from the JWT at connect time
 * and must never trust a cached/stale role for the lifetime of the socket.
 */
export async function resolveActiveRole(userId: string): Promise<UserRole | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { activeRole: true } });
  return user?.activeRole ?? null;
}

/**
 * Authorizes that `userId`, acting as `activeRole`, is a participant of
 * `conversationId`. This is the ONE place CLIENT/PROVIDER conversation access
 * is decided — every read/write path and every Socket.IO handler must go
 * through this (or conversationRoleFilter for listing) instead of an
 * OR-across-both-columns check, which is exactly the role-isolation bug this
 * closes.
 */
export async function authorizeConversationForRole(
  conversationId: string,
  userId: string,
  activeRole: UserRole | string | null | undefined
): Promise<{ id: string } | null> {
  const roleFilter = conversationRoleFilter(userId, activeRole);
  if (!roleFilter) return null;
  return prisma.conversation.findFirst({ where: { id: conversationId, ...roleFilter }, select: { id: true } });
}

class ChatService {
  /**
   * Initiate or retrieve an existing conversation between a Client and a Provider for a specific Project
   */
  async initiateConversation(userId: string, data: CreateConversationDto) {
    const { projectId, offerId } = data;

    // Fetch user account type
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, accountType: true, activeRole: true, firstName: true, lastName: true }
    });

    if (!currentUser) {
      throw new AppError('المستخدم الحالي غير مرخص بالوصول', 401);
    }

    // Determine Client ID and Provider ID
    let clientId = data.clientId;
    let providerId = data.providerId;

    let project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, clientId: true, providerId: true, title: true, specialty: true, budgetMin: true, budgetMax: true, budgetFixed: true }
    });

    let clientRequest = await prisma.clientRequest.findUnique({
      where: { id: projectId },
      include: { clientProfile: true }
    });

    if (!project && !clientRequest) {
      throw new AppError('المشروع المحدد غير موجود', 404);
    }

    const targetClientId = project?.clientId || clientRequest?.clientProfile?.userId;

    if (!project && clientRequest) {
      try {
        project = await prisma.project.create({
          data: {
            id: clientRequest.id,
            title: clientRequest.title,
            description: clientRequest.description,
            specialty: 'عام',
            subSpecialties: clientRequest.subSpecialties,
            deliveryDays: clientRequest.expectedDurationDays || 14,
            budgetType: String(clientRequest.budgetType).toLowerCase(),
            budgetMin: clientRequest.minBudget,
            budgetMax: clientRequest.maxBudget,
            budgetFixed: clientRequest.minBudget,
            attachments: clientRequest.attachments,
            requirements: clientRequest.requiredSkills,
            status: 'OPEN',
            clientId: targetClientId!
          },
          select: { id: true, clientId: true, providerId: true, title: true, specialty: true, budgetMin: true, budgetMax: true, budgetFixed: true }
        });
      } catch (err) {
        project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, clientId: true, providerId: true, title: true, specialty: true, budgetMin: true, budgetMax: true, budgetFixed: true }
        });
      }
    }

    // Attempt provider resolution from offerId if providerId wasn't passed directly
    if (!providerId && offerId) {
      const pProp = await prisma.projectProposal.findUnique({ where: { id: offerId } });
      if (pProp) {
        providerId = pProp.providerId;
      } else {
        const prop = await prisma.proposal.findUnique({ where: { id: offerId } });
        if (prop) {
          providerId = prop.providerId;
        }
      }
    }

    // Use the user's CURRENT activeRole, not the immutable accountType — a
    // multi-role user's accountType may say CLIENT while they are actively
    // negotiating as PROVIDER (or vice versa), and initiating a conversation
    // must reflect who they are acting as right now, not their original type.
    // Fall back to accountType only if activeRole is unset (should not
    // happen for an authenticated user, but keeps this from throwing on a
    // stale/legacy record).
    const isActingAsClient = currentUser.activeRole
      ? currentUser.activeRole === UserRole.CLIENT
      : (currentUser.accountType === 'CLIENT_INDIVIDUAL' || currentUser.accountType === 'CLIENT_COMPANY');
    if (isActingAsClient) {
      clientId = currentUser.id;
      if (!providerId && project?.providerId) {
        providerId = project.providerId;
      }
    } else {
      providerId = currentUser.id;
      clientId = project?.clientId || targetClientId;
    }

    if (!clientId || !providerId) {
      throw new AppError('لا يمكن إنشاء محادثة: يجب تحديد طالب الخدمة ومقدم الخدمة', 400);
    }

    if (data.negotiationPayload) {
      if (!isActingAsClient || currentUser.id !== targetClientId || !offerId) {
        throw new AppError('لا يمكن بدء التفاوض دون عرض صالح يملكه هذا المشروع', 403);
      }
      const [canonicalOffer, legacyOffer] = await Promise.all([
        prisma.projectProposal.findFirst({ where: { id: offerId, projectId, providerId } }),
        prisma.proposal.findFirst({ where: { id: offerId, providerId, OR: [{ projectId }, { clientRequestId: projectId }] } })
      ]);
      if (!canonicalOffer && !legacyOffer) throw new AppError('العرض المحدد لا يتبع هذا المشروع أو مقدم الخدمة', 404);
      await prisma.$transaction([
        prisma.projectProposal.updateMany({
          where: { projectId, providerId, status: { in: ['SUBMITTED', 'PENDING'] } },
          data: { status: 'UNDER_NEGOTIATION' }
        }),
        prisma.proposal.updateMany({
          where: { providerId, OR: [{ projectId }, { clientRequestId: projectId }], status: { in: ['SUBMITTED', 'PENDING'] } },
          data: { status: 'UNDER_NEGOTIATION' }
        })
      ]);
    }

    // Check if conversation already exists
    let conversation = await prisma.conversation.findUnique({
      where: {
        projectId_providerId: {
          projectId,
          providerId
        }
      },
      include: {
        project: {
          select: { title: true, specialty: true, budgetMin: true, budgetMax: true, budgetFixed: true }
        },
        client: {
          select: { id: true, firstName: true, lastName: true, avatarUrl: true, accountType: true }
        },
        provider: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            accountType: true,
            providerProfile: { select: { headline: true } }
          }
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 50,
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
          }
        }
      }
    });

    // Create new conversation if it does not exist
    if (!conversation) {
      const newConv = await prisma.conversation.create({
        data: {
          projectId,
          providerId,
          clientId,
          offerId: offerId || null
        }
      });

      // Insert an initial system welcome message
      await prisma.message.create({
        data: {
          conversationId: newConv.id,
          senderId: userId,
          type: MessageType.SYSTEM,
          content: `تم إطلاق غرفة التفاوض الحصري لمشروع: "${project?.title || clientRequest?.title || 'مشروع وسيط'}". وسيط AI مطّلع لضمان حماية الأطراف وتوثيق التفاوض.`,
          status: MessageStatus.READ
        }
      });

      // Refetch with relations
      conversation = await prisma.conversation.findUnique({
        where: { id: newConv.id },
        include: {
          project: {
            select: { title: true, specialty: true, budgetMin: true, budgetMax: true, budgetFixed: true }
          },
          client: {
            select: { id: true, firstName: true, lastName: true, avatarUrl: true, accountType: true }
          },
          provider: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
              accountType: true,
              providerProfile: { select: { headline: true } }
            }
          },
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 50,
            include: {
              sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
            }
          }
        }
      });
    }

    if (!conversation) {
      throw new AppError('تعذر إنشاء المحادثة', 500);
    }

    // If negotiation payload was sent during initiation, store it as a negotiation card message
    if (data.negotiationPayload) {
      const payloadContent = 'WS_NEGOTIATION::' + JSON.stringify(data.negotiationPayload);
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          type: MessageType.TEXT,
          content: payloadContent,
          status: MessageStatus.SENT
        }
      });
    }

    return this.formatConversationOutput(conversation, userId);
  }

  /**
   * Fetch list of all active conversations for an authenticated user
   */
  async getConversations(userId: string, activeRole: UserRole | string | null | undefined) {
    const roleFilter = conversationRoleFilter(userId, activeRole);
    // AFFILIATE (or any role with no CLIENT/PROVIDER chat mapping) sees an
    // empty inbox rather than falling back to "every conversation this user
    // is part of" — that fallback is exactly the role-isolation bug.
    if (!roleFilter) return [];

    const conversations = await prisma.conversation.findMany({
      where: roleFilter,
      orderBy: { updatedAt: 'desc' },
      include: {
        project: {
          select: { title: true, specialty: true, budgetMin: true, budgetMax: true, budgetFixed: true }
        },
        client: {
          select: { id: true, firstName: true, lastName: true, avatarUrl: true, accountType: true }
        },
        provider: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            accountType: true,
            providerProfile: { select: { headline: true } }
          }
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 30,
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
          }
        },
        _count: {
          select: {
            messages: {
              where: {
                senderId: { not: userId },
                status: { not: MessageStatus.READ }
              }
            }
          }
        }
      }
    });

    return conversations.map((conv) => this.formatConversationOutput(conv, userId));
  }

  /**
   * Get paginated message history for a specific conversation
   */
  async getMessages(conversationId: string, userId: string, page: number = 1, limit: number = 20, activeRole?: UserRole | string | null) {
    const conversation = await authorizeConversationForRole(conversationId, userId, activeRole);

    if (!conversation) {
      throw new AppError('المحادثة غير موجودة أو غير مصرح بالوصول', 403);
    }

    const skip = (page - 1) * limit;

    // Mark unread messages from other sender as READ
    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        status: { not: MessageStatus.READ }
      },
      data: { status: MessageStatus.READ }
    });

    const [total, messages] = await Promise.all([
      prisma.message.count({ where: { conversationId } }),
      prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
        }
      })
    ]);

    return {
      total,
      page,
      limit,
      data: [...messages].reverse().map((m) => this.formatMessage(m, userId))
    };
  }

  /**
   * Persist a new message in database and update conversation timestamp
   */
  async sendMessage(senderId: string, data: SendMessageDto, activeRole: UserRole | string | null | undefined) {
    const { conversationId, content, type, fileUrl, fileName, fileSize, audioDuration, duration, context } = data;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation) {
      throw new AppError('المحادثة غير موجودة أو غير مصرح لك بالإرسال فيها', 403);
    }

    const roleFilter = conversationRoleFilter(senderId, activeRole);
    const isAuthorized = Boolean(roleFilter && (
      ('clientId' in roleFilter && conversation.clientId === roleFilter.clientId) ||
      ('providerId' in roleFilter && conversation.providerId === roleFilter.providerId)
    ));
    if (!isAuthorized) {
      throw new AppError('المحادثة غير موجودة أو غير مصرح لك بالإرسال فيها', 403);
    }

    const messageData: any = {
      conversationId,
      senderId,
      type: (type as MessageType) || MessageType.TEXT,
      content: content || null,
      fileUrl: fileUrl || null,
      fileName: fileName || null,
      fileSize: fileSize ? Number(fileSize) : null,
      audioDuration: (audioDuration ?? duration) ? Number(audioDuration ?? duration) : null,
      status: MessageStatus.SENT
    };

    // Attach discussion context if provided (requires migration 20260903120000)
    if (context && typeof context === 'object') {
      messageData.context = context;
    }

    let newMsg;
    try {
      newMsg = await prisma.message.create({
        data: messageData,
        include: {
          sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
        }
      });
    } catch (err: any) {
      // If the context column doesn't exist yet (migration not run), retry without it
      if (context && err && typeof err.message === 'string' && err.message.includes('context')) {
        delete messageData.context;
        newMsg = await prisma.message.create({
          data: messageData,
          include: {
            sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
          }
        });
      } else {
        throw err;
      }
    }

    // Touch conversation updatedAt timestamp
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
    });

    const recipientIsClient = conversation.clientId !== senderId;
    const recipientId = recipientIsClient ? conversation.clientId : conversation.providerId;
    // The recipient's role IN THIS conversation — used by the Socket.IO
    // gateway to avoid pushing a "conversation_list_update" (which carries
    // message content) into the recipient's dashboard while they're actively
    // using a different role than the one this conversation belongs to.
    const recipientRole: UserRole = recipientIsClient ? UserRole.CLIENT : UserRole.PROVIDER;

    return {
      message: this.formatMessage(newMsg, senderId),
      recipientId,
      recipientRole,
      conversationId
    };
  }

  /**
   * Mark all unread messages as read in a conversation
   */
  async markAsRead(conversationId: string, userId: string, activeRole: UserRole | string | null | undefined) {
    const conversation = await authorizeConversationForRole(conversationId, userId, activeRole);
    if (!conversation) throw new AppError('المحادثة غير موجودة أو غير مصرح بالوصول', 403);
    await prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        status: { not: MessageStatus.READ }
      },
      data: { status: MessageStatus.READ }
    });

    return { success: true, conversationId };
  }

  private formatMessage(msg: any, currentUserId: string) {
    const isMe = msg.senderId === currentUserId;
    const date = new Date(msg.createdAt);
    const timeStr = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    const initials = msg.sender ? `${msg.sender.firstName?.[0] || ''}${msg.sender.lastName?.[0] || ''}` : 'AI';

    return {
      id: msg.id,
      conversationId: msg.conversationId,
      sender: isMe ? 'me' : 'other',
      senderId: msg.senderId,
      senderName: msg.sender ? `${msg.sender.firstName} ${msg.sender.lastName}` : 'وسيط AI',
      // Always the real sender's initials (already computed above from the
      // included sender relation) — this used to hardcode a placeholder for
      // isMe, showing a name unrelated to whoever is actually logged in.
      senderInitials: initials,
      type: msg.type,
      text: msg.content || '',
      fileUrl: msg.fileUrl,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      audioDuration: msg.audioDuration,
      status: msg.status,
      context: (msg as any).context || null,
      time: timeStr,
      createdAt: msg.createdAt,
      dateGroup: 'اليوم'
    };
  }

  private formatConversationOutput(conv: any, currentUserId: string) {
    const isUserClient = conv.clientId === currentUserId;
    const partner = isUserClient ? conv.provider : conv.client;
    const partnerName = partner ? `${partner.firstName} ${partner.lastName}` : 'مستخدم';
    const partnerInitials = partner ? `${partner.firstName?.[0] || ''}${partner.lastName?.[0] || ''}` : 'م';

    let avatarType: 'sk' | 'pr' | 'co' = isUserClient ? 'pr' : 'sk';
    if (partner?.accountType?.includes('COMPANY')) {
      avatarType = 'co';
    }

    let projectBudget = 'غير محدد';
    if (conv.project?.budgetMin && conv.project?.budgetMax) {
      projectBudget = `${conv.project.budgetMin.toLocaleString()} - ${conv.project.budgetMax.toLocaleString()} ريال`;
    } else if (conv.project?.budgetFixed) {
      projectBudget = `${conv.project.budgetFixed.toLocaleString()} ريال`;
    }

    const rawMessages = conv.messages || [];
    // Ensure messages are sorted ascending by timestamp for proper chat thread display
    const sortedMessages = [...rawMessages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const formattedMessages = sortedMessages.map((m) => this.formatMessage(m, currentUserId));

    const lastMsgObj = sortedMessages[sortedMessages.length - 1];
    let lastMsgText = 'تم إنشاء المحادثة';
    if (lastMsgObj) {
      if (lastMsgObj.type === 'AUDIO') lastMsgText = '🎤 رسالة صوتية';
      else if (lastMsgObj.type === 'IMAGE') lastMsgText = '📷 مرفق صورة';
      else if (lastMsgObj.type === 'FILE') lastMsgText = `📁 ${lastMsgObj.fileName || 'ملف مرفق'}`;
      else lastMsgText = lastMsgObj.content || lastMsgText;
    }

    const date = new Date(conv.updatedAt || conv.createdAt);
    const timeStr = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
    const unreadCount = conv._count?.messages ?? 0;

    return {
      id: conv.id,
      projectId: conv.projectId,
      offerId: conv.offerId,
      name: partnerName,
      partnerId: partner?.id,
      partnerAvatar: partner?.avatarUrl,
      project: conv.project?.title || 'مشروع وسيط',
      projectSpecialty: conv.project?.specialty || (isUserClient && partner?.providerProfile?.headline ? partner.providerProfile.headline : 'تطوير وتصميم'),
      projectBudget,
      avatarType,
      initials: partnerInitials,
      lastMsg: lastMsgText,
      time: timeStr,
      unreadCount,
      online: true,
      messages: formattedMessages
    };
  }
}

export const chatService = new ChatService();
