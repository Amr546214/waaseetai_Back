import { Request, Response } from 'express';
import { MarketplaceService } from '../services/marketplace-service.service';
import { aiAuditService } from '../services/ai-audit.service';
import { prisma } from '../config/db';

const marketplaceService = new MarketplaceService();

export class MarketplaceServiceController {
	async getPreData(req: Request, res: Response) {
		try {
			const userId = (req as any).user.id;
			const data = await marketplaceService.getProviderPreData(userId);
			res.status(200).json(data);
		} catch (error: any) {
			res.status(400).json({ error: error.message });
		}
	}

	async createService(req: Request, res: Response) {
		try {
			const userId = (req as any).user.id;
			const service = await marketplaceService.createService(userId, req.body);
			res.status(201).json(service);
		} catch (error: any) {
			res.status(400).json({ error: error.message });
		}
	}

	async getServiceById(req: Request, res: Response) {
		try {
			const userId = (req as any).user.id;
			const serviceId = req.params.id as string;
			const service = await marketplaceService.getServiceById(userId, serviceId);
			res.status(200).json({ success: true, data: service });
		} catch (error: any) {
			res.status(400).json({ success: false, error: error.message });
		}
	}

	async updateService(req: Request, res: Response) {
		try {
			const userId = (req as any).user.id;
			const serviceId = req.params.id as string;
			const updated = await marketplaceService.updateService(userId, serviceId, req.body);
			res.status(200).json({ success: true, data: updated });
		} catch (error: any) {
			res.status(400).json({ success: false, error: error.message });
		}
	}

	async toggleVisibility(req: Request, res: Response) {
		try {
			const userId = req.user!.id;
			const serviceId = req.params.id as string;
			const visible = req.body?.visible;
			if (typeof visible !== 'boolean') {
				return res.status(400).json({ success: false, error: 'visible must be a boolean' }) as any;
			}
			const updated = await marketplaceService.setServiceVisibility(userId, serviceId, visible);
			return res.status(200).json({ success: true, data: updated }) as any;
		} catch (error: any) {
			return res.status(400).json({ success: false, error: error.message }) as any;
		}
	}

	async getMarketplaceModels(req: Request, res: Response) {
		try {
			const models = await marketplaceService.getMarketplaceModels(req.query);
			res.status(200).json({ success: true, data: models });
		} catch (error: any) {
			res.status(400).json({ success: false, error: error.message });
		}
	}

	async getMarketplaceModelById(req: Request, res: Response) {
		try {
			const model = await marketplaceService.getMarketplaceModelById(req.params.id as string);
			res.status(200).json({ success: true, data: model });
		} catch (error: any) {
			res.status(404).json({ success: false, error: error.message });
		}
	}

	async getAiRecommendations(req: Request, res: Response) {
		try {
			const result = await marketplaceService.getAiRecommendations(req.body);
			res.status(200).json(result);
		} catch (error: any) {
			res.status(400).json({ success: false, error: error.message });
		}
	}

	async getMarketplaceCategories(req: Request, res: Response) {
		try {
			const result = await marketplaceService.getMarketplaceCategories();
			res.status(200).json(result);
		} catch (error: any) {
			res.status(400).json({ success: false, error: error.message });
		}
	}

	async getFavorites(req: Request, res: Response) {
		try {
			const data = await marketplaceService.getFavorites(req.user!.id);
			return res.status(200).json({ success: true, data }) as any;
		} catch (error: any) {
			return res.status(400).json({ success: false, error: error.message }) as any;
		}
	}

	async setFavorite(req: Request, res: Response) {
		try {
			if (typeof req.body?.favorite !== 'boolean') return res.status(400).json({ success: false, error: 'favorite must be boolean' }) as any;
			const data = await marketplaceService.setFavorite(req.user!.id, req.params.id as string, req.body.favorite);
			return res.status(200).json({ success: true, data }) as any;
		} catch (error: any) {
			return res.status(400).json({ success: false, error: error.message }) as any;
		}
	}

	async getMyPurchaseStatus(req: Request, res: Response) {
		try {
			const data = await marketplaceService.getMyPurchaseStatus(req.user!.id, req.params.id as string);
			return res.status(200).json({ success: true, data }) as any;
		} catch (error: any) {
			return res.status(400).json({ success: false, error: error.message }) as any;
		}
	}

	async requestService(req: Request, res: Response) {
		try {
			const data = await marketplaceService.requestMarketplaceService(req.user!.id, req.params.id as string, req.body);
			return res.status(201).json({ success: true, data }) as any;
		} catch (error: any) {
			return res.status(400).json({ success: false, error: error.message }) as any;
		}
	}

	async publishBusinessModel(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id || req.body.userId;
			if (!userId) {
				return res.status(401).json({ success: false, error: 'User authentication required' }) as any;
			}

			if (req.body.title && req.body.stages) {
				const service = await marketplaceService.createService(userId, req.body);
				return res.status(201).json({ success: true, data: service, message: 'Model published successfully' }) as any;
			} else if (req.body.modelId || req.body.id) {
				const id = req.body.modelId || req.body.id;
				const existing = await prisma.serviceCatalog.findFirst({ where: { id, providerId: userId } });
				if (!existing) {
					return res.status(404).json({ success: false, error: 'Model not found' }) as any;
				}
				const updated = await prisma.serviceCatalog.update({
					where: { id: existing.id },
					data: { status: 'PUBLISHED', approvedAt: existing.approvedAt || new Date() }
				});
				return res.status(200).json({ success: true, data: updated, message: 'Model published successfully' }) as any;
			}
			return res.status(400).json({ success: false, error: 'Invalid model payload provided' }) as any;
		} catch (error: any) {
			return res.status(400).json({ success: false, error: error.message }) as any;
		}
	}

	async reAuditAllPendingModels(req: Request, res: Response) {
		try {
			const pendingModels = await prisma.serviceCatalog.findMany({
				where: {
					status: { in: ['PENDING_APPROVAL', 'UNDER_REVIEW', 'DRAFT'] as any }
				}
			});

			console.log(`[ReAudit] Found ${pendingModels.length} pending models to re-audit.`);

			for (const model of pendingModels) {
				await aiAuditService.executeAuditSync(model.id, model.providerId);
			}

			return res.status(200).json({
				success: true,
				count: pendingModels.length,
				message: `Successfully triggered AI audit for ${pendingModels.length} pending models.`
			}) as any;
		} catch (error: any) {
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}

	async getMyMarketModels(req: Request, res: Response) {
		try {
			// Prevent Nginx and Browser from returning 304 Not Modified
			res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
			res.setHeader('Pragma', 'no-cache');
			res.setHeader('Expires', '0');

			const userId = (req as any).user?.id // Fallback to current provider ID if unauth in dev
			const result = await marketplaceService.getMyMarketModels(userId, req.query);
			return res.status(200).json(result) as any;
		} catch (error: any) {
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}
}
