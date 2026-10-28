import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';

/** Per-ticket limits. */
export const PROOF_MAX_WRONG_CODES = 5;
export const PROOF_MAX_DATA_TRIES = 3;

export const hashEmail = (email: string): string => crypto.createHash('sha256').update(email).digest('hex');

type Tx = Prisma.TransactionClient;

/**
 * Durable, shared state of e-mail-first registration tickets. Every counter change is ONE atomic UPDATE whose WHERE clause carries the limit, so
 * parallel requests (and several processes) cannot both pass a limit, and nothing is kept in memory (a restart loses nothing).
 */
export const registrationProofRepository = {
  async create(nonce: string, email: string, expiresAt: Date): Promise<void> {
    await prisma.registrationEmailProof.create({ data: { nonce, emailHash: hashEmail(email), expiresAt } });
    // housekeeping: rows are useless a day after they expired
    await prisma.registrationEmailProof.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }).catch(() => undefined);
  },

  /**
   * Reserves one attempt BEFORE the code is compared: provisionally counts a wrong code and a data try. False = unknown, expired, used,
   * locked (5 wrong codes) or out of data tries (3 rejected completions), or issued for another address.
   */
  async claim(nonce: string, email: string): Promise<boolean> {
    const r = await prisma.registrationEmailProof.updateMany({
      where: { nonce, emailHash: hashEmail(email), consumedAt: null, expiresAt: { gt: new Date() }, wrongAttempts: { lt: PROOF_MAX_WRONG_CODES }, dataTries: { lt: PROOF_MAX_DATA_TRIES } },
      data: { wrongAttempts: { increment: 1 }, dataTries: { increment: 1 } }
    });
    return r.count === 1;
  },

  /** The code was wrong: the data try is given back, the wrong-code count stays. */
  async settleWrongCode(nonce: string): Promise<void> {
    await prisma.registrationEmailProof.updateMany({ where: { nonce, dataTries: { gt: 0 } }, data: { dataTries: { decrement: 1 } } });
  },

  /** The code was right: the provisional wrong-code count is given back; the data try stays until the account exists. */
  async settleRightCode(nonce: string): Promise<void> {
    await prisma.registrationEmailProof.updateMany({ where: { nonce, wrongAttempts: { gt: 0 } }, data: { wrongAttempts: { decrement: 1 } } });
  },

  /** Marks the ticket as used INSIDE the transaction that creates the account: exactly one transaction can do it; false = already used. */
  async consumeInTx(tx: Tx, nonce: string): Promise<boolean> {
    const r = await tx.registrationEmailProof.updateMany({ where: { nonce, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    return r.count === 1;
  }
};
