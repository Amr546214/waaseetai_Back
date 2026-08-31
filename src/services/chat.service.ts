import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import { CreateConversationDto, SendMessageDto } from '../dtos/chat.dto';
import { MessageType, MessageStatus } from '@prisma/client';

class ChatService {
  /**
   * Initiate or retrieve an existing conversation between a Client and a Provider for a specific Project
   */
  async initiateConversation(userId: string, data: CreateConversationDto) {
    const { projectId, offerId } = data;

    // Fetch user account type
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, accountType: true, firstName: true, lastName: true }
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

    const isClientAccountType = currentUser.accountType === 'CLIENT_INDIVIDUAL' || currentUser.accountType === 'CLIENT_COMPANY';
    if (isClientAccountType) {
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
      if (!isClientAccountType || currentUser.id !== targetClientId || !offerId) {
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
  async getConversations(userId: string) {
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { clientId: userId },
          { providerId: userId }
        ]
      },
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
  async getMessages(conversationId: string, userId: string, page: number = 1, limit: number = 20) {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        OR: [{ clientId: userId }, { providerId: userId }]
      }
    });

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
  async sendMessage(senderId: string, data: SendMessageDto) {
    const { conversationId, content, type, fileUrl, fileName, fileSize, audioDuration, duration } = data;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation || (conversation.clientId !== senderId && conversation.providerId !== senderId)) {
      throw new AppError('المحادثة غير موجودة أو غير مصرح لك بالإرسال فيها', 403);
    }

    const newMsg = await prisma.message.create({
      data: {
        conversationId,
        senderId,
        type: (type as MessageType) || MessageType.TEXT,
        content: content || null,
        fileUrl: fileUrl || null,
        fileName: fileName || null,
        fileSize: fileSize ? Number(fileSize) : null,
        audioDuration: (audioDuration ?? duration) ? Number(audioDuration ?? duration) : null,
        status: MessageStatus.SENT
      },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } }
      }
    });

    // Touch conversation updatedAt timestamp
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() }
    });

    const recipientId = conversation.clientId === senderId ? conversation.providerId : conversation.clientId;

    return {
      message: this.formatMessage(newMsg, senderId),
      recipientId,
      conversationId
    };
  }

  /**
   * Mark all unread messages as read in a conversation
   */
  async markAsRead(conversationId: string, userId: string) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, OR: [{ clientId: userId }, { providerId: userId }] },
      select: { id: true }
    });
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
      senderInitials: isMe ? 'أن' : initials,
      type: msg.type,
      text: msg.content || '',
      fileUrl: msg.fileUrl,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      audioDuration: msg.audioDuration,
      status: msg.status,
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
