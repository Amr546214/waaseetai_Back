import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { AccountType, Prisma, UserRole, UserStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../config/db';
import { AppError, fieldError } from '../utils/app-error';
import { authPasswordSchema } from '../utils/auth-password-policy';
import { writeAccessAudit } from './admin-roles.service';
import { siteBaseUrl } from '../utils/site-url';

export const INVITE_INVALID = 'INVITE_INVALID';
const INVITE_TTL_MS = 72 * 3600_000;
const MAX_RESENDS = 3;
const MIN_RESEND_GAP_MS = 60_000;
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Delivery of the invitation e-mail. The default sends NOTHING (the owner copies the link); a real sender is only wired when ADMIN_INVITE_EMAIL_ENABLED=true. */
export interface InviteMailer { send(to: string, fullName: string, link: string, roleName: string): Promise<boolean> }
export const noMailer: InviteMailer = { async send() { return false; } };

export class AdminInvitesService {
	constructor(private db: typeof defaultPrisma = defaultPrisma, private now: () => Date = () => new Date(), private mailer: InviteMailer = noMailer) {}

	private link(token: string) { return `${siteBaseUrl() ?? ''}/admin-invite/${token}`; }

	async create(actorId: string, input: { email?: unknown; fullName?: unknown; roleId?: unknown }) {
		const email = normEmail(input.email);
		if (!EMAIL.test(email) || email.length > 254) throw fieldError('email', 'صيغة البريد الإلكتروني غير صحيحة');
		const fullName = String(input.fullName ?? '').trim().replace(/\s+/g, ' ');
		if (fullName.length < 3 || fullName.length > 120) throw fieldError('fullName', 'الاسم الكامل مطلوب');
		const roleId = String(input.roleId ?? '');
		const role = await this.db.adminRole.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
		if (!role) throw fieldError('roleId', 'اختر دورًا موجودًا');
		if (await this.db.user.findUnique({ where: { email }, select: { id: true } })) throw fieldError('email', 'يوجد حساب بهذا البريد. أضفه إلى الفريق من «حسابات إدارية قائمة» إن كان حساب إدارة.', 409);
		const token = newToken();
		let inv;
		try {
			inv = await this.db.$transaction(async tx => {
				// one PENDING invitation per e-mail: a second one for the same address is refused (cancel the first, or resend it)
				const open = await tx.adminInvite.findFirst({ where: { email, status: 'PENDING', expiresAt: { gt: this.now() } } });
				if (open) throw fieldError('email', 'توجد دعوة معلقة لهذا البريد', 409);
				const row = await tx.adminInvite.create({ data: { email, fullName, roleId, invitedById: actorId, tokenHash: sha256(token), expiresAt: new Date(this.now().getTime() + INVITE_TTL_MS), lastSentAt: this.now() } });
				await writeAccessAudit(tx, { actorId, action: 'INVITE_CREATED', inviteId: row.id, after: { email, roleId } });
				return row;
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw fieldError('email', 'توجد دعوة معلقة لهذا البريد', 409);
			throw e;
		}
		const link = this.link(token);
		const emailed = await this.mailer.send(email, fullName, link, role.name).catch(() => false);
		return { id: inv.id, email, expiresAt: inv.expiresAt, emailed, link }; // the link is shown to the owner once, here
	}

	async resend(actorId: string, id: string) {
		const inv = await this.db.adminInvite.findUnique({ where: { id }, include: { role: { select: { name: true } } } });
		if (!inv || inv.status !== 'PENDING') throw new AppError('لا توجد دعوة معلقة بهذا المعرّف', 404);
		const now = this.now();
		if (inv.resendCount >= MAX_RESENDS) throw new AppError('بلغت الدعوة حد إعادة الإرسال. ألغِها وأنشئ دعوة جديدة.', 429, undefined, 'INVITE_RESEND_LIMIT');
		if (inv.lastSentAt && now.getTime() - inv.lastSentAt.getTime() < MIN_RESEND_GAP_MS) throw new AppError('انتظر دقيقة قبل إعادة الإرسال.', 429, undefined, 'INVITE_RESEND_TOO_SOON');
		const token = newToken();
		// a new token replaces the old one (the old link stops working), the expiry window restarts
		const res = await this.db.adminInvite.updateMany({ where: { id, status: 'PENDING', resendCount: inv.resendCount }, data: { tokenHash: sha256(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS), lastSentAt: now, resendCount: { increment: 1 } } });
		if (res.count === 0) throw new AppError('تغيّرت الدعوة. أعد التحميل.', 409);
		await writeAccessAudit(this.db, { actorId, action: 'INVITE_RESENT', inviteId: id });
		const link = this.link(token);
		const emailed = await this.mailer.send(inv.email, inv.fullName, link, inv.role.name).catch(() => false);
		return { id, expiresAt: new Date(now.getTime() + INVITE_TTL_MS), emailed, link };
	}

	async cancel(actorId: string, id: string) {
		const res = await this.db.adminInvite.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: this.now() } });
		if (res.count === 0) throw new AppError('لا توجد دعوة معلقة بهذا المعرّف', 404);
		await writeAccessAudit(this.db, { actorId, action: 'INVITE_CANCELLED', inviteId: id });
		return { id, status: 'CANCELLED' };
	}

	private async byToken(token: unknown) {
		if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new AppError('الدعوة غير صالحة أو انتهت.', 400, undefined, INVITE_INVALID);
		const inv = await this.db.adminInvite.findUnique({ where: { tokenHash: sha256(token) }, include: { role: { select: { name: true } } } });
		if (!inv || inv.status !== 'PENDING' || inv.expiresAt <= this.now()) throw new AppError('الدعوة غير صالحة أو انتهت.', 400, undefined, INVITE_INVALID);
		return inv;
	}

	/** Public: what the recipient sees before accepting. Nothing but the e-mail (masked), the role name and the expiry. */
	async preview(token: unknown) {
		const inv = await this.byToken(token);
		const [u, d] = inv.email.split('@');
		return { email: `${u.slice(0, 2)}***@${d}`, roleName: inv.role.name, expiresAt: inv.expiresAt };
	}

	/**
	 * Public: the recipient accepts. The one-time token proves control of the invited address; it is consumed in the same transaction that creates the account and the staff row
	 * (a conditional claim of the PENDING row: two concurrent acceptances cannot both win, and a used / cancelled / expired token never works). An address that already has an account
	 * is refused: this path never converts an existing account.
	 */
	async accept(token: unknown, input: { password?: unknown }) {
		const pw = authPasswordSchema.safeParse(input.password);
		if (!pw.success) throw fieldError('password', pw.error.issues[0]?.message ?? 'كلمة المرور غير صالحة');
		const inv = await this.byToken(token);
		const hash = await bcrypt.hash(pw.data, 12);
		const [first, ...rest] = inv.fullName.split(' ');
		try {
			return await this.db.$transaction(async tx => {
				const claim = await tx.adminInvite.updateMany({ where: { id: inv.id, status: 'PENDING', expiresAt: { gt: this.now() } }, data: { status: 'ACCEPTED', acceptedAt: this.now() } });
				if (claim.count === 0) throw new AppError('الدعوة غير صالحة أو استُخدمت.', 400, undefined, INVITE_INVALID);
				const user = await tx.user.create({ data: {
					accountType: AccountType.ADMIN, status: UserStatus.ACTIVE, roles: [UserRole.ADMIN], activeRole: UserRole.ADMIN, firstName: first, lastName: rest.join(' ') || first,
					email: inv.email, password: hash, agreedToTerms: true, authProvider: 'local',
				} });
				await tx.adminInvite.update({ where: { id: inv.id }, data: { acceptedUserId: user.id } });
				await tx.adminStaff.create({ data: { userId: user.id, roleId: inv.roleId, invitedById: inv.invitedById } });
				await writeAccessAudit(tx, { actorId: user.id, action: 'INVITE_ACCEPTED', subjectUserId: user.id, inviteId: inv.id, after: { roleId: inv.roleId } });
				return { userId: user.id, email: user.email };
			});
		} catch (e) {
			if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError('يوجد حساب بهذا البريد. لا يمكن قبول الدعوة عليه.', 409, undefined, 'ACCOUNT_EXISTS');
			throw e;
		}
	}
}
export const adminInvitesService = new AdminInvitesService();
