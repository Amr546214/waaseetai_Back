import { Request, Response } from 'express';
import { providerReportsService } from '../services/provider-reports.service';
import { ReportDateRange } from '../services/client-reports.service';

const VALID_RANGES: ReportDateRange[] = ['month', '3m', '6m', 'year', 'all'];

export class ProviderReportsController {
	async getReports(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const requested = String(req.query.range || 'month') as ReportDateRange;
			const range = VALID_RANGES.includes(requested) ? requested : 'month';
			const data = await providerReportsService.getReports(userId, range);
			return res.status(200).json({ success: true, data }) as any;
		} catch (error: any) {
			console.error('[ProviderReportsController] Error building reports:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}
}

export const providerReportsController = new ProviderReportsController();
