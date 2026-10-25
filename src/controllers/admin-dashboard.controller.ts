import { Request, Response, NextFunction } from 'express';
import { adminDashboardService } from '../services/admin-dashboard.service';
import { loadAdminActor } from '../middlewares/admin-access.middleware';
import { shapeActivity, shapeCharts, shapeSummary } from '../utils/admin-dashboard-shaping';

// Open to every admin-team member, shaped to what THEIR permissions allow (see utils/admin-dashboard-shaping.ts).
export const getDashboardSummary = async (req: Request, res: Response, next: NextFunction) => {
	try { const actor = await loadAdminActor(req); res.status(200).json({ success: true, data: shapeSummary(await adminDashboardService.getSummary(), actor) }); } catch (error) { next(error); }
};

export const getDashboardCharts = async (req: Request, res: Response, next: NextFunction) => {
	try { const actor = await loadAdminActor(req); res.status(200).json({ success: true, data: shapeCharts(await adminDashboardService.getCharts(Number(req.query.days)), actor) }); } catch (error) { next(error); }
};

export const getDashboardActivity = async (req: Request, res: Response, next: NextFunction) => {
	try { const actor = await loadAdminActor(req); res.status(200).json({ success: true, data: shapeActivity(await adminDashboardService.getActivity(Number(req.query.limit)), actor) }); } catch (error) { next(error); }
};
