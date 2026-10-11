import { Request, Response } from 'express';
import { CONTACT_IMMUTABLE, CONTACT_IMMUTABLE_MESSAGE } from '../utils/contact-policy';

// The account phone is immutable from the interface for every role: there is no code flow to change it any more. The routes stay (an old client gets a
// clear answer instead of a 404) and always refuse.
const refuse = (_req: Request, res: Response) => void res.status(403).json({ success: false, code: CONTACT_IMMUTABLE, message: CONTACT_IMMUTABLE_MESSAGE });

export const phoneChangeController = { request: refuse, confirm: refuse };
