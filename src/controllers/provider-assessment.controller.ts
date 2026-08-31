import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { assessmentGeneratorService } from '../services/assessment-generator.service';
import { TestSessionStatus } from '@prisma/client';

export async function startDynamicSession(req: Request, res: Response): Promise<void> {
  const providerSpecialtyId = req.body.providerSpecialtyId;
  const userId = (req as any).user?.id || 'demo-user-id';

  if (!providerSpecialtyId) {
    res.status(400).json({ success: false, message: 'providerSpecialtyId is required.' });
    return;
  }

  try {
    const providerSpecialty = await prisma.providerSpecialty.findUnique({
      where: { id: providerSpecialtyId },
      include: {
        specialty: true,
        aiAuditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });

    if (!providerSpecialty) {
      res.status(404).json({ success: false, message: 'Provider specialty not found.' });
      return;
    }

    const latestAudit = providerSpecialty.aiAuditLogs[0];
    const contextData = latestAudit ? (latestAudit.rawResponse as any)?.content : {};

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins

    const createdSession = await prisma.specialtyTestSession.create({
      data: {
        userId,
        providerSpecialtyId,
        status: TestSessionStatus.IN_PROGRESS,
        totalQuestions: 20,
        correctAnswers: 0,
        scorePercentage: 0.0,
        passed: false,
        antiCheatViolations: 0,
        startedAt: new Date(),
        expiresAt,
        questionsPayload: {} as any
      }
    });

    const specialtyName = providerSpecialty.specialty.nameAr || providerSpecialty.specialty.name || 'التخصص المهني';
    const generatedQuiz = await assessmentGeneratorService.generateDynamicQuiz(
      createdSession.id,
      specialtyName,
      providerSpecialty.subSpecialties,
      contextData
    );

    await prisma.specialtyTestSession.update({
      where: { id: createdSession.id },
      data: {
        questionsPayload: generatedQuiz as any
      }
    });

    // Sanitize response to prevent cheating
    const sanitizedQuestions = generatedQuiz.questions.map(q => ({
      id: q.id,
      questionText: q.questionText,
      options: q.options.map(opt => ({
        id: opt.id,
        text: opt.text
      }))
    }));

    res.status(201).json({
      success: true,
      data: {
        sessionId: createdSession.id,
        specialtyName,
        totalQuestions: sanitizedQuestions.length,
        durationMins: 30,
        expiresAt: createdSession.expiresAt,
        questions: sanitizedQuestions
      }
    });

  } catch (error: any) {
    console.error('[Start Dynamic Session Error]:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء إنشاء الاختبار الفوري.', error: error?.message });
  }
}
