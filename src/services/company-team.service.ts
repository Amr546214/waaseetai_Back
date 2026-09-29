import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AppError } from '../utils/app-error';
import type { CreateTeamMemberInput, UpdateTeamMemberInput } from '../dtos/company-team.dto';

// Company team members are plain records owned by the PROVIDER_COMPANY
// account (companyOwnerId). Every query is scoped by companyOwnerId so a
// company can never read or mutate another company's roster.

function format(member: any) {
  return {
    id: member.id, name: member.name, email: member.email, phone: member.phone,
    jobTitle: member.jobTitle, memberType: member.memberType, status: member.status,
    avatarUrl: member.avatarUrl, createdAt: member.createdAt, updatedAt: member.updatedAt
  };
}

function rethrowDuplicateEmail(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new AppError('يوجد عضو في الفريق بنفس البريد الإلكتروني', 409);
  }
  throw error;
}

export class CompanyTeamService {
  async create(companyOwnerId: string, input: CreateTeamMemberInput) {
    try {
      const member = await prisma.companyTeamMember.create({ data: {
        companyOwnerId, name: input.name, email: input.email, phone: input.phone ?? null,
        jobTitle: input.jobTitle, memberType: input.memberType,
        status: input.status ?? 'PENDING', avatarUrl: input.avatarUrl ?? null
      } });
      return format(member);
    } catch (error) { rethrowDuplicateEmail(error); }
  }

  async list(companyOwnerId: string) {
    const members = await prisma.companyTeamMember.findMany({ where: { companyOwnerId }, orderBy: { createdAt: 'desc' } });
    return members.map(format);
  }

  async get(companyOwnerId: string, id: string) {
    const member = await prisma.companyTeamMember.findFirst({ where: { id, companyOwnerId } });
    if (!member) throw new AppError('عضو الفريق غير موجود', 404);
    return format(member);
  }

  async update(companyOwnerId: string, id: string, input: UpdateTeamMemberInput) {
    const current = await prisma.companyTeamMember.findFirst({ where: { id, companyOwnerId }, select: { id: true } });
    if (!current) throw new AppError('عضو الفريق غير موجود', 404);
    try {
      const member = await prisma.companyTeamMember.update({ where: { id }, data: input });
      return format(member);
    } catch (error) { rethrowDuplicateEmail(error); }
  }

  async remove(companyOwnerId: string, id: string) {
    const result = await prisma.companyTeamMember.deleteMany({ where: { id, companyOwnerId } });
    if (!result.count) throw new AppError('عضو الفريق غير موجود', 404);
    return { id, deleted: true };
  }
}

export const companyTeamService = new CompanyTeamService();
