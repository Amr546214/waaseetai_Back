import { AppError } from './app-error';

/** True when Prisma reports a relation (table) that does not exist yet: P2021, or P2010 wrapping Postgres 42P01. */
export function isMissingTableError(error: unknown): boolean {
	const e = error as { code?: string; message?: string; meta?: { code?: string } } | null;
	if (!e) return false;
	if (e.code === 'P2021') return true;
	return e.code === 'P2010' && (e.meta?.code === '42P01' || /does not exist/i.test(String(e.message)));
}

/** Runs a DB call; if its table has not been migrated yet, answers 503 with an honest Arabic message instead of a 500. */
export async function withTableGuard<T>(fn: () => Promise<T>, what: string): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (isMissingTableError(error)) throw new AppError(`${what} غير جاهز بعد: لم يتم تطبيق تحديث قاعدة البيانات اللازم. يرجى مراجعة فريق التشغيل.`, 503);
		throw error;
	}
}
