import { Request, Response, NextFunction } from 'express';
import { fieldError } from '../utils/app-error';
import { adminAnalyticsService, parseAnalyticsRange } from '../services/admin-analytics.service';

// GET /admin/analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD — read-only.
export const getAnalyticsOverview = async (req: Request, res: Response, next: NextFunction) => {
	try {
		const range = parseAnalyticsRange(req.query.from, req.query.to);
		if (range.from && range.to && range.from > range.to) {
			throw fieldError('from', 'تاريخ البداية يجب أن يسبق تاريخ النهاية');
		}
		const data = await adminAnalyticsService.overview(range);
		res.status(200).json({ success: true, data });
	} catch (error) {
		next(error);
	}
};
