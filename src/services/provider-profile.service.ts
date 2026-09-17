import { prisma } from '../config/db';
import { storeDataUriIfNeeded } from '../utils/cloudinary-storage';
import OpenAI from 'openai';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { notificationService } from './notification.service';
import { accountAuditLogService, AuditContext } from './account-logs.service';
import { LEVEL_MATRIX } from './gamification.service';
import { resolveProviderProgression } from '../utils/role-display-resolver';

const aiCache = new Map<string, { metrics: any, expiresAt: number }>();

export class ProviderProfileService {
  async changePassword(userId: string, currentPassword: string, newPassword: string, auditContext?: AuditContext) {
    if (!currentPassword || !newPassword) throw new Error('PASSWORD_FIELDS_REQUIRED');
    if (newPassword.length < 8 || newPassword.length > 72) throw new Error('WEAK_PASSWORD');
    const characterGroups = [/[a-z]/.test(newPassword), /[A-Z]/.test(newPassword), /\d/.test(newPassword), /[^A-Za-z0-9]/.test(newPassword)].filter(Boolean).length;
    if (characterGroups < 3) throw new Error('WEAK_PASSWORD');

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
    if (!user || !user.password || !(await bcrypt.compare(currentPassword, user.password))) {
      await accountAuditLogService.record({ userId, eventType: 'PASSWORD_CHANGE_REJECTED', category: 'SECURITY_CHANGE', title: 'محاولة تغيير كلمة المرور', summary: 'رُفضت محاولة تغيير كلمة المرور لأن الكلمة الحالية غير صحيحة', source: 'USER', severity: 'WARNING', status: 'REJECTED', context: auditContext });
      throw new Error('CURRENT_PASSWORD_INCORRECT');
    }
    if (await bcrypt.compare(newPassword, user.password)) throw new Error('PASSWORD_UNCHANGED');

    const password = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: userId }, data: { password } });
    await this.logAppliedChange(userId, 'SECURITY', 'تغيير كلمة المرور', 'قيمة محمية', 'قيمة محمية');
    await accountAuditLogService.record({ userId, eventType: 'PASSWORD_CHANGED', category: 'SECURITY_CHANGE', title: 'تغيير كلمة المرور', summary: 'تم تغيير كلمة مرور الحساب بنجاح', source: 'USER', severity: 'CRITICAL', context: auditContext });
    return { changedAt: new Date() };
  }
	async getProfile(userId: string) {
		let profile = await prisma.providerProfile.findUnique({
			where: { userId },
			include: {
				user: {
					select: {
						firstName: true, lastName: true, email: true, avatarUrl: true,
						phoneNumber: true, alternativePhone: true,
						accountHolderName: true, ibanNumber: true, bankName: true,
						idDocumentUrl: true, commercialRegistration: true, vatCertificateUrl: true
					}
				},
				skills: true,
				portfolioItems: true,
				educations: true,
				certificates: true,
			},
		});

		if (!profile) {
			profile = await prisma.providerProfile.create({
				data: {
					userId,
				},
				include: {
					user: {
						select: {
							firstName: true, lastName: true, email: true, avatarUrl: true,
							phoneNumber: true, alternativePhone: true,
							accountHolderName: true, ibanNumber: true, bankName: true,
							idDocumentUrl: true, commercialRegistration: true, vatCertificateUrl: true
						}
					},
					skills: true,
					portfolioItems: true,
					educations: true,
					certificates: true,
				},
			});
		}

		if (profile?.user?.ibanNumber) {
			const iban = profile.user.ibanNumber;
			if (iban.length > 4) {
				profile.user.ibanNumber = '*'.repeat(iban.length - 4) + iban.slice(-4);
			}
		}

		return profile;
	}

	private async generateAiMetrics(providerId: string, profile: any, gamification: any, completedProjectsCount: number, reviewsCount: number) {
		// If the provider has no projects and no reviews, their metrics are genuinely 0.
		if (completedProjectsCount === 0 && reviewsCount === 0) {
			return {
				executionQuality: 0,
				onTimeDelivery: 0,
				communication: 0,
				clientSatisfaction: 0,
				onTimeCompletionRate: 0,
				repeatClientRate: 0,
				highRatingServicesRate: 0,
				conflictFreeDeliveryRate: 0
			};
		}

		if (aiCache.has(providerId)) {
			const cached = aiCache.get(providerId)!;
			if (Date.now() < cached.expiresAt) {
				return cached.metrics;
			}
		}

		try {
			const openai = new OpenAI();
			const prompt = `Analyze the following freelance provider profile data and generate realistic performance metrics out of 100 for the following 8 categories:
      - executionQuality (جودة التنفيذ)
      - onTimeDelivery (الالتزام بالمواعيد)
      - communication (التواصل)
      - clientSatisfaction (رضا العملاء)
      - onTimeCompletionRate (معدل الإنجاز في الوقت المحدد)
      - repeatClientRate (معدل إعادة الطلب من نفس العميل)
      - highRatingServicesRate (نسبة الخدمات فوق 4.8 نجمة)
      - conflictFreeDeliveryRate (نسبة التسليم بدون نزاعات)

      Provider Data:
      Headline: ${profile.headline}
      Bio: ${profile.bio}
      Years of Experience: ${profile.yearsOfExperience}
      Skills: ${profile.skills.map((s: any) => s.name).join(', ')}
      Completed Projects: ${completedProjectsCount}
      Reviews Count: ${reviewsCount}
      Average Rating: ${reviewsCount > 0 ? (gamification?.avgRating || profile.rating || 5) : 0}

      Return ONLY a JSON object with these 8 exact keys and integer values between 0 and 100.
      CRITICAL RULE: If the provider has very few projects, scores should be extremely low or realistic based ONLY on that data. Do not hallucinate high scores.`;

			const response = await openai.chat.completions.create({
				model: 'gpt-4o-mini',
				messages: [{ role: 'user', content: prompt }],
				response_format: { type: 'json_object' }
			});

			const metrics = JSON.parse(response.choices[0].message.content || '{}');
			aiCache.set(providerId, { metrics, expiresAt: Date.now() + 1000 * 60 * 60 }); // Cache for 1 hour
			return metrics;
		} catch (error) {
			console.error('Error generating AI metrics:', error);
			// Fallback
			return {
				executionQuality: 0,
				onTimeDelivery: 0,
				communication: 0,
				clientSatisfaction: 0,
				onTimeCompletionRate: 0,
				repeatClientRate: 0,
				highRatingServicesRate: 0,
				conflictFreeDeliveryRate: 0
			};
		}
	}

	async getPublicProfile(providerId: string) {
		const profile = await prisma.providerProfile.findUnique({
			where: { userId: providerId },
			include: {
				user: {
					select: {
						firstName: true,
						lastName: true,
						email: true,
						avatarUrl: true,
						phoneNumber: true,
						createdAt: true,
						currentLevel: true,
						ratingAverage: true,
						profileCompletionPercent: true,
					}
				},
				skills: true,
				portfolioItems: true,
				providerSpecialties: {
					where: { isActive: true },
					include: {
						specialty: true,
						assessmentAttempts: {
							where: { status: 'COMPLETED' },
							orderBy: { completedAt: 'desc' }
						},
						accreditationSamples: {
							where: { serviceCatalogs: { some: { status: { in: ['PUBLISHED', 'APPROVED'] } } } }
						}
					}
				}
			}
		});

		if (!profile) {
			throw new Error('Provider not found');
		}

		const completedProjectsCount = await prisma.project.count({
			where: { providerId, status: 'COMPLETED' }
		});

		const publishedServices = await prisma.serviceCatalog.findMany({
			where: { providerId, status: { in: ['PUBLISHED', 'APPROVED'] } },
			orderBy: { createdAt: 'desc' }
		});
		const publishedServicesCount = publishedServices.length;

		const reviews = await prisma.review.findMany({
			where: { providerId, reviewerRole: 'CLIENT' },
			orderBy: { createdAt: 'desc' },
			take: 20,
			include: {
				client: { select: { firstName: true, lastName: true, avatarUrl: true } },
				project: { select: { title: true } }
			}
		});
		const reviewsCount = await prisma.review.count({ where: { providerId, reviewerRole: 'CLIENT' } });

		const gamification = await prisma.providerGamification.findUnique({
			where: { providerId }
		});

		const completedTasks = gamification?.completedProjects || completedProjectsCount;

		// Rating is usually out of 5 in the DB. We need to convert it to a percentage (out of 100) for the UI.
		const baseRating = reviewsCount > 0 ? (gamification?.avgRating || profile.user?.ratingAverage || profile.rating || 0) : 0;
		const clientRating = baseRating <= 5 ? Math.round((baseRating / 5) * 100) : baseRating;

		const points = gamification?.points || 0;
		// Phase 3C bug fix: derive the level title via the same pure, already-tested
		// resolveProviderProgression() used by the dashboard/auth resolvers, instead
		// of the previous inline lookup here. That inline logic defaulted a missing
		// ProviderGamification.currentLevelIndex to 1 BEFORE checking any fallback,
		// so LEVEL_MATRIX index 1 ("زائر") always matched and profile.user.currentLevel
		// was never actually reached — even when the provider had no
		// ProviderGamification row at all. resolveProviderProgression checks for a
		// missing gamification row FIRST and only falls back to the passed-in legacy
		// currentLevel in that case; LEVEL_MATRIX.find(...) || LEVEL_MATRIX[0] is its
		// own safe fallback when a gamification row exists but currentLevelIndex
		// doesn't match any entry. Only `.currentLevel` is taken from the result —
		// `points` above is left completely untouched, scoping this fix to the
		// level-name derivation only.
		const levelName = resolveProviderProgression(gamification, {
			firstName: '',
			lastName: '',
			avatarUrl: null,
			profileCompletionPercent: 0,
			currentLevel: profile.user?.currentLevel || LEVEL_MATRIX[0].title,
			currentPoints: 0,
			pointsToNextLevel: 0
		}).currentLevel;

		const formatter = new Intl.DateTimeFormat('ar-EG', { month: 'long', year: 'numeric' });
		const memberSince = profile.user?.createdAt ? formatter.format(profile.user.createdAt) : '2024';

		const aiMetricsEngine = await this.generateAiMetrics(providerId, profile, gamification, completedProjectsCount, reviewsCount);

		let specialtiesFormatted = (profile.providerSpecialties || []).map((ps: any) => {
			const latestAttempt = ps.assessmentAttempts?.[0] || null;
			return {
				id: ps.id,
				specialtyName: ps.specialty?.nameAr || ps.specialty?.name || 'تخصص عام',
				icon: ps.specialty?.iconName || 'code',
				subSpecialties: ps.subSpecialties || [],
				status: ps.status,
				hasTakenAssessment: ps.hasTakenAssessment || !!latestAttempt,
				isPassed: ps.isPassed || (latestAttempt?.isPassed ?? false),
				latestScore: ps.latestScore || latestAttempt?.score || 0,
				passedAt: ps.passedAt || latestAttempt?.completedAt || null,
				aiMetrics: {
					aiScore: ps.aiScore || 0,
					feasibilityScore: ps.feasibilityScore || 0,
					clarityScore: ps.clarityScore || 0
				},
				assessmentDetails: latestAttempt ? {
					totalQuestions: latestAttempt.totalQuestions || 20,
					timeTakenMinutes: latestAttempt.timeLimitMinutes || 12,
					score: latestAttempt.score || ps.latestScore || 0,
					feedbackAr: latestAttempt.feedbackAr || '',
					strengths: latestAttempt.strengths || [],
					weaknesses: latestAttempt.weaknesses || [],
					completedAt: latestAttempt.completedAt || ps.passedAt || new Date()
				} : null,
					samples: (ps.accreditationSamples || []).map((sample: any) => ({
					id: sample.id,
					title: sample.title,
					description: sample.description,
					technologiesUsed: sample.technologiesUsed || [],
					imageUrl: (sample.attachments || []).find((url: unknown) => typeof url === 'string' && /(?:^data:image\/|\.(?:png|jpe?g|webp|gif)(?:\?|$))/i.test(url)) || null,
					aiScore: sample.aiScore || 0,
					aiQualityRating: sample.aiQualityRating || 'PENDING',
					aiFeedbackAr: sample.aiFeedbackAr || ''
				}))
			};
		});

		let allPortfolioItems: any[] = (profile.portfolioItems || []).map((item: any) => ({
			id: item.id,
			title: item.title,
			description: item.description,
			technologies: item.tags || [],
			images: item.coverImage ? [item.coverImage] : [],
			thumbnailUrl: item.coverImage,
			projectUrl: item.projectUrl
		}));

		specialtiesFormatted.forEach((spec: any) => {
			if (spec.samples && spec.samples.length > 0) {
				spec.samples.forEach((sample: any) => {
					allPortfolioItems.push({
						id: sample.id,
						title: sample.title,
						description: sample.description,
						technologies: sample.technologiesUsed,
						images: sample.imageUrl ? [sample.imageUrl] : [],
						thumbnailUrl: sample.imageUrl
					});
				});
			}
		});

		let totalScore = 0;
		let testsCount = 0;
		let totalCodeScore = 0;
		let codeSamplesCount = 0;

		specialtiesFormatted.forEach((spec: any) => {
			if (spec.latestScore > 0) {
				totalScore += spec.latestScore;
				testsCount++;
			}
			if (spec.samples && spec.samples.length > 0) {
				spec.samples.forEach((sample: any) => {
					if (sample.aiScore > 0) {
						totalCodeScore += sample.aiScore;
						codeSamplesCount++;
					}
				});
			}
		});

		const averageTestScore = testsCount > 0 ? Math.round(totalScore / testsCount) : 0;
		const codeMatchingIndex = codeSamplesCount > 0 ? Number((totalCodeScore / codeSamplesCount).toFixed(1)) : 0;

		return {
			header: {
				fullName: `${profile.user?.firstName || ''} ${profile.user?.lastName || ''}`.trim() || 'مزود خدمة',
				avatarUrl: profile.user?.avatarUrl || null,
				memberSince,
				isVerified: profile.isVerified || false,
				location: profile.location || profile.city || 'غير محدد',
				stats: {
					completedProjects: completedProjectsCount,
					completedTasks,
					publishedServices: publishedServicesCount,
					reviewsCount,
					portfolioCount: allPortfolioItems.length,
					clientRating
				},
				levelInfo: {
					levelName: levelName,
					points,
					completionPercentage: profile.user?.profileCompletionPercent || profile.completionPercentage || 0,
					missingHint: 'استكمل بيانات ملفك الشخصي لرفع مستوى مصداقيتك'
				}
			},
			basicInfo: {
				fullName: `${profile.user?.firstName || ''} ${profile.user?.lastName || ''}`.trim() || 'مزود خدمة',
				headline: profile.headline || '',
				yearsOfExperience: profile.yearsOfExperience ? `${profile.yearsOfExperience} سنوات` : '',
				satisfactionRate: `${clientRating}%`,
				address: profile.location || profile.city || '',
				bio: profile.bio || ''
			},
			skills: profile.skills.map(s => s.name),
			specialties: specialtiesFormatted,
			services: publishedServices,
			reviews: reviews,
			portfolioItems: allPortfolioItems,
			socialLinks: {
				github: profile.githubUrl || null,
				linkedin: profile.linkedinUrl || null,
				website: profile.websiteUrl || null
			},
			aiMetrics: {
				...aiMetricsEngine,
				averageTestScore,
				codeMatchingIndex
			}
		};
	}

	/**
	 * Phase 3D.1: firstName/lastName/avatarUrl are written directly onto this
	 * ProviderProfile row's own display columns (Phase 3A) — never nested
	 * onto the legacy User row anymore. The previous `user: { update: {...} }`
	 * here mutated the shared User.firstName/lastName/avatarUrl, which would
	 * have silently changed the same identity's visible CLIENT/AFFILIATE name
	 * too, since User is the shared identity, not a role-specific profile.
	 *
	 * Authorization note (inspected, not changed): this route
	 * (`PUT /provider/profile/basic-info`) is only gated by
	 * `authenticate, requireActiveUser` (src/routes/provider-profile.routes.ts:22) —
	 * there is no `authorize(...)` or PROVIDER-ownership check on this router
	 * at all. That means any authenticated, active user who already has a
	 * ProviderProfile row (e.g. a multi-role account, regardless of their
	 * current activeRole) can call this today, and a user with no
	 * ProviderProfile row gets a Prisma "record not found" error from the
	 * `.update()` below rather than a clean 403/404. This is a pre-existing
	 * gap, not something this Phase 3D.1 change touches: adding an
	 * activeRole===PROVIDER check (or a role-ownership check) here would be a
	 * real API-contract change for existing multi-role callers, so it is left
	 * alone per the Phase 3D.1 scope and reported separately rather than
	 * silently added.
	 */
	async updateBasicInfo(userId: string, data: any, auditContext?: AuditContext) {
		const firstName = String(data.firstName || '').trim();
		const lastName = String(data.lastName || '').trim();
		const headline = String(data.headline || '').trim();
		const bio = String(data.bio || '').trim();
		if (!firstName || !lastName || !headline || !String(data.mainSpecialty || '').trim()) throw new Error('REQUIRED_PROFILE_FIELDS');
		if (firstName.length > 60 || lastName.length > 60 || headline.length > 100 || bio.length > 500) throw new Error('PROFILE_FIELD_TOO_LONG');
		for (const key of ['githubUrl', 'linkedinUrl', 'websiteUrl']) {
			if (data[key]) { try { const url = new URL(String(data[key])); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw new Error(`INVALID_URL:${key}`); } }
		}
		const avatarUrl = data.avatarUrl === undefined ? undefined : await storeDataUriIfNeeded(data.avatarUrl, `waseetai/users/${userId}/avatar`, 'avatar');
		const before = await this.getProfile(userId);
		const updatedProfile = await prisma.providerProfile.update({
			where: { userId },
			data: {
				headline,
				bio,
				hourlyRate: data.hourlyRate,
				yearsOfExperience: data.yearsOfExperience,
				location: data.location,
				city: data.city,
				country: data.country,
				availabilityStatus: data.availabilityStatus,
				mainSpecialty: data.mainSpecialty,
				githubUrl: data.githubUrl,
				linkedinUrl: data.linkedinUrl,
				twitterUrl: data.twitterUrl,
				websiteUrl: data.websiteUrl,
				...(Array.isArray(data.languages) && { languages: data.languages }),
				...(data.preferences && { preferences: data.preferences }),
				// firstName/lastName are required/validated above, so they're
				// always present here; avatarUrl stays optional.
				firstName,
				lastName,
				...(data.avatarUrl !== undefined && { avatarUrl })
			},
			include: {
				user: {
					select: {
						firstName: true, lastName: true, email: true, avatarUrl: true,
						phoneNumber: true, alternativePhone: true,
						accountHolderName: true, ibanNumber: true, bankName: true,
						idDocumentUrl: true, commercialRegistration: true, vatCertificateUrl: true
					}
				}
			}
		});

		const result = await this.getProfile(userId);
		const completion = this.calculateProfileCompletion(result);
		await prisma.$transaction([
			prisma.providerProfile.update({ where: { userId }, data: { completionPercentage: completion } }),
			prisma.user.update({ where: { id: userId }, data: { profileCompletionPercent: completion } })
		]);
		result.completionPercentage = completion;
		await this.logAppliedChange(userId, 'PROFILE', 'الملف المهني', before, data);
		await accountAuditLogService.record({ userId, eventType: 'PROFILE_UPDATED', category: 'PROFILE_COMPLETION', title: 'تحديث الملف المهني', summary: 'تم حفظ تعديلات الملف المهني مباشرة', source: 'USER', status: 'COMPLETED', before, after: data, context: auditContext });
		return result;
	}

	private calculateProfileCompletion(profile: any) {
		let score = 0;
		// Phase 3D.1: prefer this ProviderProfile row's OWN firstName/lastName/
		// avatarUrl (Phase 3A columns) now that updateBasicInfo writes them
		// here instead of onto the legacy User row — falling back to the
		// legacy User value only for a provider who hasn't set these on their
		// own profile yet, so no one's existing score drops as a result of
		// this change. Not a formula/weights redesign — same fields, same
		// points, only the two factors' data SOURCE changed to match the new
		// write target.
		const avatarUrl = profile.avatarUrl || profile.user?.avatarUrl;
		const firstName = profile.firstName || profile.user?.firstName;
		const lastName = profile.lastName || profile.user?.lastName;
		if (avatarUrl) score += 10;
		if (firstName && lastName && profile.headline && profile.mainSpecialty) score += 15;
		if (profile.bio?.length >= 50) score += 15;
		if (profile.skills?.length) score += 10;
		if (profile.portfolioItems?.length || profile.websiteUrl) score += 10;
		if (profile.user?.email && profile.user?.phoneNumber) score += 10;
		if (profile.country && profile.city) score += 10;
		if (profile.user?.ibanNumber) score += 10;
		if (profile.user?.idDocumentUrl) score += 10;
		return Math.min(100, score);
	}

	async getChangeRequests(userId: string, tabName: string) {
		const categoryMap: Record<string, string> = { contact: 'CONTACT', banking: 'BANKING', docs: 'DOCUMENTS', profile: 'PROFILE' };
		const category = categoryMap[tabName];
		if (!category) return [];
		const requests = await prisma.profileModificationRequest.findMany({
			where: { providerId: userId, category },
			orderBy: { createdAt: 'desc' },
			take: 50
		});
		return requests.map(request => this.toPublicRequest({ ...request, tabName }));
	}

	async updateContactInfo(userId: string, data: any) {
		throw new Error('OTP_REQUIRED: use /sensitive-change and verify the emailed OTP');
	}

	async updateBankingInfo(userId: string, data: any) {
		throw new Error('OTP_REQUIRED: use /sensitive-change and verify the emailed OTP');
	}

	async updateDocsInfo(userId: string, data: any) {
		throw new Error('OTP_REQUIRED: use /sensitive-change and verify the emailed OTP');
	}

	async updateSkills(userId: string, skillNames: string[]) {
		const profile = await prisma.providerProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error("Profile not found");

		const skillIds = await Promise.all(skillNames.map(async name => {
			const skill = await prisma.skill.upsert({
				where: { name },
				update: {},
				create: { name }
			});
			return skill.id;
		}));

		await prisma.providerProfile.update({
			where: { userId },
			data: {
				skills: {
					set: skillIds.map(id => ({ id }))
				}
			}
		});

		return this.getProfile(userId);
	}

	async addPortfolioItem(userId: string, data: any) {
		const profile = await prisma.providerProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error("Profile not found");

		const coverImage = await storeDataUriIfNeeded(data.coverImage, `waseetai/providers/${userId}/portfolio`, 'cover');
		return prisma.portfolioItem.create({
			data: {
				providerProfileId: profile.id,
				title: data.title,
				description: data.description,
				coverImage,
				projectUrl: data.projectUrl,
				completionDate: data.completionDate ? new Date(data.completionDate) : null,
				tags: data.tags || [],
			}
		});
	}

	async updatePortfolioItem(userId: string, itemId: string, data: any) {
		const profile = await prisma.providerProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error("Profile not found");

		const ownedItem = await prisma.portfolioItem.findFirst({ where: { id: itemId, providerProfileId: profile.id } });
		if (!ownedItem) throw new Error('Portfolio item not found or unauthorized');

		const coverImage = await storeDataUriIfNeeded(data.coverImage, `waseetai/providers/${userId}/portfolio`, `cover-${itemId}`);
		return prisma.portfolioItem.update({
			where: { id: itemId },
			data: {
				title: data.title,
				description: data.description,
				coverImage,
				projectUrl: data.projectUrl,
				completionDate: data.completionDate ? new Date(data.completionDate) : null,
				tags: data.tags || [],
			}
		});
	}

	async deletePortfolioItem(userId: string, itemId: string) {
		const profile = await prisma.providerProfile.findUnique({ where: { userId } });
		if (!profile) throw new Error('Profile not found');
		const result = await prisma.portfolioItem.deleteMany({ where: { id: itemId, providerProfileId: profile.id } });
		if (result.count !== 1) throw new Error('Portfolio item not found or unauthorized');
		return result;
	}

	// Modification Requests Methods

	private async logAppliedChange(providerId: string, category: string, fieldLabel: string, currentValue: unknown, requestedValue: unknown) {
		return prisma.profileModificationRequest.create({
			data: {
				providerId,
				category,
				fieldName: category,
				fieldLabel,
				currentValue: this.toAuditValue(currentValue),
				requestedValue: this.toAuditValue(requestedValue),
				status: 'APPROVED',
				aiAuditStatus: 'PASSED',
				aiConfidence: 100,
				aiRecommendation: 'تحديث عادي تم تطبيقه فورًا وتسجيله في سجل التدقيق.',
				reviewedByAdmin: false,
				appliedAt: new Date(),
				metadata: { applicationMode: 'IMMEDIATE' }
			}
		});
	}

	private toAuditValue(value: unknown): string {
		if (value === null || value === undefined || value === '') return 'غير محدد';
		const raw = typeof value === 'string' ? value : JSON.stringify(value);
		if (raw.startsWith('data:')) return 'ملف مرفق';
		return raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
	}

	private isFileField(key: string): boolean {
		return /(document|certificate|registration|attachment|file|image|photo|avatar|proof)/i.test(key);
	}

	private fileNameOnly(value: unknown): string {
		if (typeof value !== 'string' || !value) return 'غير محدد';
		if (value.startsWith('data:')) return 'ملف مرفق';
		try {
			const pathname = new URL(value).pathname;
			const lastPart = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || 'ملف مرفق');
			return lastPart.replace(/-\d{10,}(?=\.[^.]+$|$)/, '') || 'ملف مرفق';
		} catch {
			const lastPart = value.split(/[\\/]/).pop() || value;
			return lastPart.replace(/-\d{10,}(?=\.[^.]+$|$)/, '');
		}
	}

	private redactFileContent(rawValue: unknown): unknown {
		let value = rawValue;
		if (typeof rawValue === 'string') {
			try { value = JSON.parse(rawValue); } catch { return rawValue.startsWith('data:') ? 'ملف مرفق' : rawValue; }
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
		const safe = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
			if (!this.isFileField(key)) return [key, item];
			if (Array.isArray(item)) return [key, item.map(file => this.fileNameOnly(file))];
			return [key, this.fileNameOnly(item)];
		}));
		return typeof rawValue === 'string' ? JSON.stringify(safe) : safe;
	}

	private toPublicRequest<T extends Record<string, any>>(request: T): Omit<T, 'metadata'> {
		const { metadata: _metadata, ...safeRequest } = request;
		return {
			...safeRequest,
			currentValue: this.redactFileContent(request.currentValue),
			requestedValue: this.redactFileContent(request.requestedValue)
		} as Omit<T, 'metadata'>;
	}

	private sensitiveConfig(category: string) {
		const configs: Record<string, { label: string; review: boolean; allowed: string[] }> = {
			CONTACT: { label: 'بيانات التواصل', review: false, allowed: ['email', 'phoneNumber', 'alternativePhone'] },
			BANKING: { label: 'البيانات البنكية', review: true, allowed: ['accountHolderName', 'ibanNumber', 'bankName'] },
			DOCUMENTS: { label: 'المستندات الرسمية', review: true, allowed: ['idDocumentUrl', 'certificatesUrl', 'commercialRegistration', 'vatCertificateUrl'] }
		};
		const config = configs[category];
		if (!config) throw new Error('Unsupported sensitive change category');
		return config;
	}

	private normalizeAndValidateSensitiveChanges(category: string, changes: Record<string, unknown>) {
		const normalized = { ...changes };
		if (category === 'CONTACT') {
			normalized.email = String(normalized.email || '').trim().toLowerCase();
			normalized.phoneNumber = String(normalized.phoneNumber || '').replace(/[\s()-]/g, '');
			normalized.alternativePhone = String(normalized.alternativePhone || '').replace(/[\s()-]/g, '');
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(normalized.email))) throw new Error('INVALID_EMAIL');
			if (!/^\+?\d{8,15}$/.test(String(normalized.phoneNumber))) throw new Error('INVALID_PHONE');
			if (normalized.alternativePhone && !/^\+?\d{8,15}$/.test(String(normalized.alternativePhone))) throw new Error('INVALID_ALTERNATIVE_PHONE');
		}
		if (category === 'BANKING') {
			normalized.accountHolderName = String(normalized.accountHolderName || '').trim();
			normalized.bankName = String(normalized.bankName || '').trim();
			normalized.ibanNumber = String(normalized.ibanNumber || '').replace(/\s/g, '').toUpperCase();
			if (String(normalized.accountHolderName).length < 3) throw new Error('INVALID_ACCOUNT_HOLDER');
			if (!normalized.bankName) throw new Error('INVALID_BANK_NAME');
			//   if (!this.isValidIban(String(normalized.ibanNumber))) throw new Error('INVALID_IBAN');
		}
		if (category === 'DOCUMENTS') {
			if (!normalized.idDocumentUrl) throw new Error('ID_DOCUMENT_REQUIRED');
			for (const [key, value] of Object.entries(normalized)) {
				if (value && !this.isSafeDocumentUrl(String(value))) throw new Error(`INVALID_DOCUMENT_URL:${key}`);
			}
		}
		return normalized;
	}

	private isValidIban(value: string) {
		if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(value)) return false;
		const rearranged = `${value.slice(4)}${value.slice(0, 4)}`;
		const numeric = rearranged.replace(/[A-Z]/g, char => String(char.charCodeAt(0) - 55));
		let remainder = 0;
		for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
		return remainder === 1;
	}

	private isSafeDocumentUrl(value: string) {
		try { return new URL(value).protocol === 'https:'; } catch { return false; }
	}

	async initiateSensitiveChange(providerId: string, category: string, changes: Record<string, unknown>, auditContext?: AuditContext) {
		const config = this.sensitiveConfig(category);
		const filtered = Object.fromEntries(Object.entries(changes || {}).filter(([key]) => config.allowed.includes(key)));
		const cleanChanges = this.normalizeAndValidateSensitiveChanges(category, filtered);
		if (!Object.keys(cleanChanges).length) throw new Error('No supported changes were provided');

		const user = await prisma.user.findUnique({ where: { id: providerId }, include: { providerProfile: true } });
		if (!user) throw new Error('User not found');

		if (category === 'CONTACT' && cleanChanges.email && cleanChanges.email !== user.email) {
			const duplicate = await prisma.user.findUnique({ where: { email: String(cleanChanges.email).trim().toLowerCase() } });
			if (duplicate && duplicate.id !== providerId) throw new Error('EMAIL_ALREADY_USED');
		}
		if (category === 'CONTACT' && cleanChanges.phoneNumber && cleanChanges.phoneNumber !== user.phoneNumber) {
			const duplicate = await prisma.user.findUnique({ where: { phoneNumber: String(cleanChanges.phoneNumber) } });
			if (duplicate && duplicate.id !== providerId) throw new Error('PHONE_ALREADY_USED');
		}

		const current: Record<string, unknown> = {};
		for (const key of Object.keys(cleanChanges)) current[key] = (user as any)[key] ?? null;
		if (category === 'DOCUMENTS' && Object.prototype.hasOwnProperty.call(cleanChanges, 'certificatesUrl')) {
			current.certificatesUrl = user.providerProfile?.certUrls?.[0] ?? null;
		}

		const request = await prisma.profileModificationRequest.create({
			data: {
				providerId,
				category,
				fieldName: category,
				fieldLabel: config.label,
				currentValue: this.toAuditValue(current),
				requestedValue: this.toAuditValue(cleanChanges),
				status: 'PENDING_OTP',
				requiresOtp: true,
				metadata: { changes: cleanChanges, requiresHumanReview: config.review } as any
			}
		});

		await prisma.otpVerification.deleteMany({ where: { userId: providerId, type: 'EMAIL' } });
		const code = crypto.randomInt(100000, 1000000).toString();
		await prisma.otpVerification.create({
			data: { userId: providerId, code, type: 'EMAIL', expiresAt: new Date(Date.now() + 10 * 60 * 1000) }
		});
		try {
			await notificationService.sendEmailOtp(user.email, code);
		} catch (error) {
			await prisma.$transaction([
				prisma.otpVerification.deleteMany({ where: { userId: providerId, type: 'EMAIL', code } }),
				prisma.profileModificationRequest.delete({ where: { id: request.id } })
			]);
			throw new Error('OTP_EMAIL_DELIVERY_FAILED');
		}
		await accountAuditLogService.record({ userId: providerId, eventType: 'SENSITIVE_CHANGE_REQUESTED', category: 'PROFILE_COMPLETION', title: config.label, summary: `تم إنشاء طلب تعديل ${config.label} وبانتظار تأكيد الهوية`, source: 'USER', status: 'IN_REVIEW', before: current, after: cleanChanges, requestId: request.id, context: auditContext });

		return { requestId: request.id, emailHint: this.maskEmail(user.email), expiresInSeconds: 600 };
	}

	async verifySensitiveChange(providerId: string, requestId: string, code: string, auditContext?: AuditContext) {
		const request = await prisma.profileModificationRequest.findFirst({ where: { id: requestId, providerId } });
		if (!request || request.status !== 'PENDING_OTP') throw new Error('REQUEST_NOT_PENDING_OTP');

		const otp = await prisma.otpVerification.findFirst({
			where: { userId: providerId, code, type: 'EMAIL', expiresAt: { gt: new Date() } },
			orderBy: { createdAt: 'desc' }
		});
		if (!otp) {
			await accountAuditLogService.record({ userId: providerId, eventType: 'OTP_VERIFICATION_REJECTED', category: 'SECURITY_CHANGE', title: 'تأكيد طلب تعديل حساس', summary: 'فشلت محاولة تأكيد الطلب لأن الرمز غير صحيح أو منتهي', source: 'USER', severity: 'WARNING', status: 'REJECTED', requestId, context: auditContext });
			throw new Error('INVALID_OR_EXPIRED_OTP');
		}

		await prisma.otpVerification.delete({ where: { id: otp.id } });
		const metadata = (request.metadata || {}) as any;
		const needsReview = Boolean(metadata.requiresHumanReview);

		if (!needsReview) {
			await this.applySensitivePayload(providerId, request.category, metadata.changes || {});
		}

		const updated = await prisma.profileModificationRequest.update({
			where: { id: request.id },
			data: {
				otpVerifiedAt: new Date(),
				status: needsReview ? 'PENDING_HUMAN_REVIEW' : 'APPROVED',
				aiAuditStatus: needsReview ? 'NEEDS_HUMAN_REVIEW' : 'PASSED',
				aiConfidence: needsReview ? 90 : 100,
				aiRecommendation: needsReview
					? 'تم تأكيد هوية صاحب الحساب عبر البريد، والطلب جاهز للمراجعة البشرية.'
					: 'تم تأكيد هوية صاحب الحساب عبر البريد وتطبيق التغيير تلقائيًا.',
				appliedAt: needsReview ? null : new Date()
			}
		});
		await accountAuditLogService.record({ userId: providerId, eventType: 'AI_REVIEW_COMPLETED', category: 'PROFILE_COMPLETION', title: request.fieldLabel, summary: needsReview ? 'اجتاز الطلب التحقق الآلي وأُحيل إلى مراجع بشري' : 'اجتاز الطلب التحقق الآلي وتم تطبيقه', source: 'AI', status: needsReview ? 'IN_REVIEW' : 'APPROVED', statusText: updated.aiRecommendation || undefined, requestId, details: { aiAuditStatus: updated.aiAuditStatus, aiConfidence: updated.aiConfidence }, context: auditContext });
		return updated;
	}

	async reviewSensitiveChange(requestId: string, approved: boolean, rejectionReason?: string, auditContext?: AuditContext) {
		const request = await prisma.profileModificationRequest.findUnique({ where: { id: requestId } });
		if (!request || request.status !== 'PENDING_HUMAN_REVIEW') throw new Error('REQUEST_NOT_PENDING_REVIEW');
		const metadata = (request.metadata || {}) as any;
		if (approved) await this.applySensitivePayload(request.providerId, request.category, metadata.changes || {});
		const updated = await prisma.profileModificationRequest.update({
			where: { id: request.id },
			data: {
				status: approved ? 'APPROVED' : 'REJECTED',
				reviewedByAdmin: true,
				rejectionReason: approved ? null : (rejectionReason || 'لم يستوفِ الطلب متطلبات التحقق'),
				appliedAt: approved ? new Date() : null
			}
		});
		await accountAuditLogService.record({ userId: request.providerId, eventType: 'HUMAN_REVIEW_COMPLETED', category: 'PROFILE_COMPLETION', title: request.fieldLabel, summary: approved ? 'اعتمد المراجع البشري طلب التعديل وتم تطبيقه' : 'رفض المراجع البشري طلب التعديل', source: 'ADMIN', severity: approved ? 'INFO' : 'WARNING', status: approved ? 'APPROVED' : 'REJECTED', statusText: updated.rejectionReason || undefined, requestId, context: auditContext });
		return updated;
	}

	async getPendingSensitiveReviews() {
		return prisma.profileModificationRequest.findMany({
			where: { status: 'PENDING_HUMAN_REVIEW' },
			include: { provider: { select: { firstName: true, lastName: true, email: true } } },
			orderBy: { createdAt: 'asc' }
		});
	}

	private async applySensitivePayload(providerId: string, category: string, changes: Record<string, unknown>) {
		const config = this.sensitiveConfig(category);
		const updateData: Record<string, unknown> = {};
		for (const key of config.allowed.filter(key => key !== 'certificatesUrl')) {
			if (Object.prototype.hasOwnProperty.call(changes, key)) updateData[key] = changes[key];
		}
		if (category === 'CONTACT' && updateData.email) updateData.email = String(updateData.email).trim().toLowerCase();
		if (category === 'BANKING' && String(updateData.ibanNumber || '').includes('*')) delete updateData.ibanNumber;
		await prisma.user.update({ where: { id: providerId }, data: updateData });
		if (category === 'DOCUMENTS' && Object.prototype.hasOwnProperty.call(changes, 'certificatesUrl')) {
			const certificateUrl = String(changes.certificatesUrl || '');
			await prisma.providerProfile.update({
				where: { userId: providerId },
				data: { certUrls: certificateUrl ? [certificateUrl] : [] }
			});
		}
	}

	private maskEmail(email: string) {
		const [name, domain] = email.split('@');
		return `${name.slice(0, 2)}${'*'.repeat(Math.max(2, name.length - 2))}@${domain}`;
	}

	async getModificationRequests(providerId: string, status?: string) {
		const whereClause: any = { providerId };
		if (status && status !== 'ALL') {
			whereClause.status = status;
		}

		const requests = await prisma.profileModificationRequest.findMany({
			where: whereClause,
			orderBy: { createdAt: 'desc' }
		});

		const [totalRequests, pendingOtpCount, inAiReviewCount, pendingHumanCount, approvedCount, rejectedCount] = await Promise.all([
			prisma.profileModificationRequest.count({ where: { providerId } }),
			prisma.profileModificationRequest.count({ where: { providerId, status: 'PENDING_OTP' } }),
			prisma.profileModificationRequest.count({ where: { providerId, status: 'IN_AI_REVIEW' } }),
			prisma.profileModificationRequest.count({ where: { providerId, status: 'PENDING_HUMAN_REVIEW' } }),
			prisma.profileModificationRequest.count({ where: { providerId, status: 'APPROVED' } }),
			prisma.profileModificationRequest.count({ where: { providerId, status: 'REJECTED' } })
		]);

		return {
			requests: requests.map(request => this.toPublicRequest(request)),
			kpi: {
				totalRequests,
				pendingOtpCount,
				inAiReviewCount,
				pendingHumanCount,
				approvedCount,
				rejectedCount
			}
		};
	}

	async createModificationRequest(providerId: string, data: { fieldName: string, fieldLabel: string, requestedValue: string }) {
		// Determine current value
		let currentValue = null;
		const user = await prisma.user.findUnique({ where: { id: providerId }, include: { providerProfile: true } });

		if (user) {
			if (['EMAIL', 'PHONE_NUMBER', 'IBAN', 'NATIONAL_ID'].includes(data.fieldName)) {
				if (data.fieldName === 'EMAIL') currentValue = user.email;
				if (data.fieldName === 'PHONE_NUMBER') currentValue = user.phoneNumber;
				if (data.fieldName === 'IBAN') currentValue = user.ibanNumber;
				if (data.fieldName === 'NATIONAL_ID') currentValue = user.idNumber;
			}
		}

		// Mock AI check
		const aiConfidence = 85 + Math.random() * 10;
		const aiAuditStatus = aiConfidence > 92 ? 'PASSED' : 'NEEDS_HUMAN_REVIEW';
		const status = aiAuditStatus === 'PASSED' ? 'APPROVED' : 'PENDING_HUMAN_REVIEW';

		let aiRecommendation = '';
		if (aiAuditStatus === 'PASSED') aiRecommendation = 'تحقق الذكاء من تطابق المعلومات مع المعايير المطلوبة.';
		else aiRecommendation = 'يتطلب مراجعة بشرية للتحقق من المرفقات.';

		const request = await prisma.profileModificationRequest.create({
			data: {
				providerId,
				fieldName: data.fieldName,
				fieldLabel: data.fieldLabel,
				currentValue,
				requestedValue: data.requestedValue,
				status,
				aiConfidence,
				aiAuditStatus,
				aiRecommendation,
			}
		});

		// Automatically apply if approved
		if (status === 'APPROVED' && user) {
			const updateData: any = {};
			if (data.fieldName === 'EMAIL') updateData.email = data.requestedValue;
			if (data.fieldName === 'PHONE_NUMBER') updateData.phoneNumber = data.requestedValue;
			if (data.fieldName === 'IBAN') updateData.ibanNumber = data.requestedValue;
			if (data.fieldName === 'NATIONAL_ID') updateData.idNumber = data.requestedValue;

			if (Object.keys(updateData).length > 0) {
				await prisma.user.update({ where: { id: providerId }, data: updateData });
			}
		}

		return request;
	}

	async cancelModificationRequest(requestId: string, providerId: string) {
		const request = await prisma.profileModificationRequest.findUnique({ where: { id: requestId } });
		if (!request || request.providerId !== providerId) {
			throw new Error('Request not found or unauthorized');
		}

		if (request.status !== 'PENDING_OTP' && request.status !== 'IN_AI_REVIEW' && request.status !== 'PENDING_HUMAN_REVIEW') {
			throw new Error('Cannot cancel request in current status');
		}

		return prisma.profileModificationRequest.update({
			where: { id: requestId },
			data: { status: 'CANCELLED' }
		});
	}
}

export const providerProfileService = new ProviderProfileService();
