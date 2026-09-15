import { Request, Response, NextFunction } from 'express';
import { subscribeNewsletterSchema, unsubscribeNewsletterSchema } from '../dtos/newsletter.dto';
import { AppError } from '../utils/app-error';
import { newsletterService } from '../services/newsletter.service';

export async function subscribeToNewsletter(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = subscribeNewsletterSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    const subscriber = await newsletterService.subscribe(parsed.data.email, parsed.data.source);
    res.status(200).json({
      success: true,
      data: { email: subscriber.email, subscribedAt: subscriber.subscribedAt },
    });
  } catch (error) { next(error); }
}

export async function unsubscribeFromNewsletter(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = unsubscribeNewsletterSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(i => i.message).join(', '), 400);
    const data = await newsletterService.unsubscribe(parsed.data.email);
    res.status(200).json({ success: true, data });
  } catch (error) { next(error); }
}
