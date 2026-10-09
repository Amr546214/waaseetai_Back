import { Request, Response } from 'express';
import { clientReportsService, ReportDateRange } from '../services/client-reports.service';
import { summariseClientReports } from '../services/ai-features/client-reports-summary.service';

const VALID_RANGES: ReportDateRange[] = ['month', '3m', '6m', 'year', 'all'];

export class ClientReportsController {
	async getReports(req: Request, res: Response) {
		try {
			const userId = (req as any).user?.id;
			const requested = String(req.query.range || 'month') as ReportDateRange;
			const range = VALID_RANGES.includes(requested) ? requested : 'month';

			const data = await clientReportsService.getReports(userId, range);
			return res.status(200).json({ success: true, data }) as any;
		} catch (error: any) {
			console.error('[ClientReportsController] Error building reports:', error);
			return res.status(500).json({ success: false, error: error.message }) as any;
		}
	}
}

export const clientReportsAiSummary = async (req: Request, res: Response) => {
	const userId = (req as any).user?.id;
	const raw = req.query.range;
	const range = (raw === undefined || raw === '' ? 'month' : raw) as ReportDateRange;
	if (!VALID_RANGES.includes(range)) return res.status(400).json({ success: false, error: 'range غير صالح' }) as any;
	try {
		// A model problem is a FAILED AiResult (HTTP 200), never an HTTP error; only the data read can throw.
		const data = await summariseClientReports(userId, range);
		return res.status(200).json({ success: true, data }) as any;
	} catch (error: any) {
		console.error('[ClientReportsController] Error building AI summary:', error);
		return res.status(500).json({ success: false, error: error.message }) as any;
	}
};

export const clientReportsController = new ClientReportsController();
