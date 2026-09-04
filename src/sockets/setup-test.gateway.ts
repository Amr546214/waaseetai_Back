import { Socket, Server as SocketIOServer } from 'socket.io';
import { prisma } from '../config/db';
import OpenAI from 'openai';
import jwt from 'jsonwebtoken';
import { DYNAMIC_QUIZ_SYSTEM_PROMPT } from '../prompts/quiz.prompt';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key_for_build',
  timeout: 30 * 1000,
  maxRetries: 1,
});

function generateSetupTestFallbackQuestions(mainSpec: string, subSpecs: string[]): any[] {
  const subs = subSpecs && subSpecs.length > 0 ? subSpecs : [mainSpec || 'البرمجة والتقنية'];
  const questions: any[] = [];
  
  const pool = [
    {
      q: 'عند العمل على مشروع ذو متطلبات متغيرة بسرعة، أي منهجية تطوير برمجية تُفضل لضمان المرونة والتواصل المستمر مع العملاء؟',
      options: ['منهجية الشلال (Waterfall)', 'منهجية الرشيقة (Agile/Scrum)', 'التطوير بدون توثيق', 'التطوير الفردي المباشر'],
      correctOptionIndex: 1,
      explanation: 'منهجية Agile تسمح بالتسليم التدريجي والاستجابة السريعة للتغيرات.'
    },
    {
      q: 'كيف تضمن حماية بيانات العميل الحساسة أثناء تنفيذ الخدمات التقنية والمستندات الرسمية؟',
      options: ['حفظها في مجلدات عامة مفتوحة', 'استخدام التشفير القوي واتفاقية عدم الإفصاح (NDA)', 'مشاركتها مع زملائك في منصات أخرى', 'تخزينها في روابط حرة بدون كلمة مرور'],
      correctOptionIndex: 1,
      explanation: 'التشفير وتوقيع اتفاقيات السرية تشكل الأساس المهني لحماية بيانات المستفيدين.'
    },
    {
      q: 'في حالة اختلاف وجهات النظر مع العميل حول تسليمات معينة في ختام المشروع، ما التصرف الأمثل؟',
      options: ['إلغاء المشروع وإغلاق التواصل', 'مراجعة نطاق العمل المحدد بالاتفاق واستخدام الوساطة الرسمية على منصة وسيط AI', 'تسليم أي طلبات إضافية مجاناً دائماً', 'رفع شكوى قبل التحدث مع العميل'],
      correctOptionIndex: 1,
      explanation: 'الرجوع لنطاق العمل المعتمد والتواصل المهني يحفظ حقوق الطرفين.'
    },
    {
      q: 'ما أفضل ممارسة لضمان أداء عالي واستجابة سريعة للواجهات والتطبيقات؟',
      options: ['تحميل جميع الموارد دفعة واحدة في الصفحة الأولى', 'استخدام التخزين المؤقت (Caching) والضغط والتحميل الكسول (Lazy Loading)', 'إلغاء نظام الفهرسة لقواعد البيانات', 'زيادة استخدام البرمجيات الكبيرة دون ضغط'],
      correctOptionIndex: 1,
      explanation: 'التحميل الكسول والتخزين المؤقت يقللان زمن الاستجابة واستهلاك النطاق الترددي.'
    },
    {
      q: 'ما أهمية إجراء اختبارات التغطية (Unit Testing & Integration Testing) قبل تسليم المشروع للمشتري؟',
      options: ['زيادة التكلفة على العميل فقط', 'كشف الثغرات والأخطاء مبكراً وضمان استقرار النظام', 'إبطاء عملية التطوير دون فائدة', 'تلبية متطلبات التصميم الفني فقط'],
      correctOptionIndex: 1,
      explanation: 'الاختبارات الأوتوماتيكية تضمن عدم حدوث انكسار في الميزات الحالية واستقرار النظام.'
    }
  ];

  for (let i = 0; i < 15; i++) {
    const sub = subs[i % subs.length];
    const item = pool[i % pool.length];
    questions.push({
      id: `q${i + 1}`,
      subSpecialtyTag: sub,
      text: `[تخصص: ${sub}] ${item.q}`,
      options: item.options,
      correctOptionIndex: item.correctOptionIndex,
      explanation: item.explanation
    });
  }

  return questions;
}

export class SetupTestGateway {
  private io: SocketIOServer | null = null;
  private testSessions = new Map<string, any>();

  private getUserIdFromToken(token?: string): string | null {
    if (!token) return null;
    let cleanToken = token;
    if (cleanToken.startsWith('"') && cleanToken.endsWith('"')) {
        cleanToken = cleanToken.slice(1, -1);
    }
    try {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) return null;
      const decoded = jwt.verify(cleanToken, jwtSecret) as any;
      return decoded?.userId || decoded?.id || null;
    } catch {
      return null;
    }
  }

  public register(socket: Socket, io?: SocketIOServer): void {
    if (io) this.io = io;

    socket.on('setup_test:init', async (payload: { token: string }) => {
      try {
        const userId = this.getUserIdFromToken(payload?.token);
        if (!userId) {
          socket.emit('setup_test:error', { message: 'رمز الحساب غير صالح أو منتهي الصلاحية.' });
          return;
        }

        const profile = await prisma.providerProfile.findUnique({ where: { userId } });
        if (!profile) {
          socket.emit('setup_test:error', { message: 'الملف الشخصي لمقدم الخدمة غير موجود.' });
          return;
        }

        if (profile.setupTestStatus === 'BANNED' || profile.setupTestBannedUntil) {
           await prisma.providerProfile.update({
             where: { id: profile.id },
             data: { setupTestStatus: 'PENDING', setupTestBannedUntil: null, setupTestCheatAttempts: 0 }
           });
        }

        socket.emit('setup_test:generating', { message: 'جاري إنشاء الاختبار المخصص لك بناءً على تخصصاتك باستخدام الذكاء الاصطناعي...' });

        const mainSpec = profile.mainSpecialty || profile.industry || 'البرمجة والتقنية';
        const subSpecs = Array.isArray(profile.subSpecialties) && profile.subSpecialties.length > 0 
          ? profile.subSpecialties 
          : [mainSpec];

        let questions: any[] = [];

        if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'dummy_key_for_build') {
          try {
            const promptUser = `يرجى إنشاء 15 سؤال اختيار من متعدد تقني لمقدم خدمة في التخصص الرئيسي "${mainSpec}" والتخصصات الفرعية [${subSpecs.join(', ')}].`;
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: DYNAMIC_QUIZ_SYSTEM_PROMPT },
                { role: 'user', content: promptUser }
              ],
              response_format: { type: "json_object" },
              temperature: 0.5,
            });
            
            const resultRaw = completion.choices[0].message.content || '{"questions": []}';
            const parsed = JSON.parse(resultRaw);
            if (parsed.questions && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
              questions = parsed.questions;
            }
          } catch (aiErr) {
            console.warn('[SetupTestGateway] OpenAI generation failed or timed out, falling back to dynamic generator:', aiErr);
          }
        }

        if (!questions || questions.length === 0) {
          questions = generateSetupTestFallbackQuestions(mainSpec, subSpecs);
        }
        
        this.testSessions.set(userId, {
            questions,
            currentQIndex: 0,
            score: 0,
            answers: []
        });

        socket.emit('setup_test:ready', { totalQuestions: questions.length });
        
      } catch (err: any) {
        console.error('[SetupTestGateway Init Error]:', err);
        socket.emit('setup_test:error', { message: 'حدث خطأ أثناء إنشاء أسئلة الاختبار.' });
      }
    });

    socket.on('setup_test:get_question', async (payload: { token: string }) => {
        try {
            const userId = this.getUserIdFromToken(payload?.token);
            if (!userId) {
                console.warn('[SetupTestGateway] get_question failed: userId could not be parsed from token');
                return;
            }
            
            const session = this.testSessions.get(userId);
            if (!session) {
                console.warn(`[SetupTestGateway] get_question failed: no active test session for user ${userId}`);
                return;
            }
            
            if (session.currentQIndex < session.questions.length) {
                const q = session.questions[session.currentQIndex];
                socket.emit('setup_test:question', {
                    id: q.id || `q${session.currentQIndex + 1}`,
                    text: q.text || q.question || q.q || 'سؤال غير محدد',
                    options: q.options || [],
                    index: session.currentQIndex,
                    total: session.questions.length
                });
            }
        } catch(e) {
          console.error('[SetupTestGateway get_question Error]:', e);
        }
    });

    socket.on('setup_test:answer', async (payload: { token: string, questionId: string, selectedIndex: number }) => {
        try {
            const userId = this.getUserIdFromToken(payload?.token);
            if (!userId) {
                console.warn('[SetupTestGateway] answer failed: userId could not be parsed');
                return;
            }
            
            const session = this.testSessions.get(userId);
            if (!session) {
                console.warn(`[SetupTestGateway] answer failed: no active test session for user ${userId}`);
                return;
            }
            
            const q = session.questions[session.currentQIndex];
            if (q && (q.id === payload.questionId || `q${session.currentQIndex + 1}` === payload.questionId)) {
                const isCorrect = q.correctOptionIndex === payload.selectedIndex;
                if (isCorrect) session.score++;
                
                session.answers.push({
                    questionId: payload.questionId,
                    selectedIndex: payload.selectedIndex,
                    isCorrect
                });
                
                session.currentQIndex++;
                
                if (session.currentQIndex < session.questions.length) {
                    const nextQ = session.questions[session.currentQIndex];
                    socket.emit('setup_test:question', {
                        id: nextQ.id || `q${session.currentQIndex + 1}`,
                        text: nextQ.text || nextQ.question || nextQ.q || 'سؤال غير محدد',
                        options: nextQ.options || [],
                        index: session.currentQIndex,
                        total: session.questions.length
                    });
                } else {
                    // Finish test
                    const percentage = (session.score / session.questions.length) * 100;
                    
                    const profile = await prisma.providerProfile.findUnique({ where: { userId } });
                    if (profile) {
                        await prisma.providerProfile.update({
                            where: { id: profile.id },
                            data: {
                                setupTestScore: percentage,
                                setupTestStatus: 'COMPLETED'
                            }
                        });
                    }
                    
                    socket.emit('setup_test:result', {
                        score: percentage,
                        passed: true,
                        total: session.questions.length,
                        correct: session.score,
                        message: 'تم الانتهاء من الاختبار بنجاح وتم تسجيل نتيجتك لتصنيف مستواك.'
                    });
                    
                    this.testSessions.delete(userId);
                }
            }
        } catch(e) {
          console.error('[SetupTestGateway answer Error]:', e);
        }
    });

    socket.on('setup_test:anti_cheat', async (payload: { token: string, type: string }) => {
        // Anti-cheat ban is currently disabled for testing purposes
        console.log(`[AntiCheat Info]: event received for testing (${payload?.type})`);
    });
  }
}

export const setupTestGateway = new SetupTestGateway();
export const registerSetupTestGateway = (socket: Socket, io?: SocketIOServer) => setupTestGateway.register(socket, io);
