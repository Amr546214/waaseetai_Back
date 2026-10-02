import { Socket, Server as SocketIOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { aiFeatureUnavailablePayload } from '../services/ai/ai-feature-unavailable';

// Provider onboarding "setup test" is DISABLED.
//
// The UI presents this test as an AI assessment ("AI يقيم مستواك المهني"), and
// its result was used to classify the provider's level. All AI must run
// exclusively through the WaseetAI service, and WaseetAI's onboarding quiz is
// a fixed generic platform quiz with no per-specialty input. The old static
// question bank was only 5 generic questions repeated with a fake
// "[تخصص: ...]" tag, so keeping it would present fabricated, specialty-tagged
// questions as a personalised assessment. Therefore the whole quiz is paused:
// no questions are generated, no score is written and no setup-test status
// is changed (the profile and any previously stored score stay untouched).
// The frontend already shows `setup_test:error` messages in an error modal.

export const SETUP_TEST_UNAVAILABLE_MESSAGE =
  'اختبار تحديد المستوى الذكي متوقف مؤقتاً حتى يكتمل ربطه بخدمة WaseetAI. يمكنك متابعة إكمال ملفك الشخصي بشكل طبيعي.';

export class SetupTestGateway {
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

  public register(socket: Socket, _io?: SocketIOServer): void {
    socket.on('setup_test:init', async (payload: { token: string }) => {
      const userId = this.getUserIdFromToken(payload?.token);
      if (!userId) {
        socket.emit('setup_test:error', { message: 'رمز الحساب غير صالح أو منتهي الصلاحية.' });
        return;
      }
      socket.emit('setup_test:error', aiFeatureUnavailablePayload(SETUP_TEST_UNAVAILABLE_MESSAGE));
    });

    // Without a generated quiz there is never an active session, so question /
    // answer requests have nothing to serve. Anti-cheat events stay accepted
    // (no-op) so older clients do not break.
    socket.on('setup_test:get_question', () => undefined);
    socket.on('setup_test:answer', () => undefined);
    socket.on('setup_test:anti_cheat', () => undefined);
  }
}

export const setupTestGateway = new SetupTestGateway();
export const registerSetupTestGateway = (socket: Socket, io?: SocketIOServer) => setupTestGateway.register(socket, io);
