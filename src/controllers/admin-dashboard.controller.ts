import { Request, Response, NextFunction } from 'express';
import { adminDashboardService } from '../services/admin-dashboard.service';

export const getDashboardSummary = async (_req: Request, res: Response, next: NextFunction) => {
	try { res.status(200).json({ success: true, data: await adminDashboardService.getSummary() }); } catch (error) { next(error); }
};

export const getDashboardCharts = async (req: Request, res: Response, next: NextFunction) => {
	try { res.status(200).json({ success: true, data: await adminDashboardService.getCharts(Number(req.query.days)) }); } catch (error) { next(error); }
};

export const getDashboardActivity = async (req: Request, res: Response, next: NextFunction) => {
	try { res.status(200).json({ success: true, data: await adminDashboardService.getActivity(Number(req.query.limit)) }); } catch (error) { next(error); }
};
