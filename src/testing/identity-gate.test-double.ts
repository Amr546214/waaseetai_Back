/**
 * For tests of the setup HANDLERS that are NOT about the identity gate (they run on a mocked `prisma`): the gate is a no-op there, exactly as before the gate existed.
 * The gate itself is tested over HTTP on real PostgreSQL in routes/identity-gate.pg.test.ts. Never imported by production code.
 */
export const identityGateTestDouble = {
  identityGateService: { assertApproved: async () => undefined, cancelIfChanged: async () => false, approvalDigest: () => 'test-digest', getState: async () => ({ status: 'APPROVED', canAdvance: true }), saveIdentity: async () => ({ status: 'UNDER_REVIEW', canAdvance: false }) },
  identityDigest: () => 'test-digest',
  deriveGateState: () => ({ status: 'APPROVED', canAdvance: true }),
  missingIdentityItems: () => [] as string[],
};

/** For REAL-database tests of the setup content (models, proofs, completion) that are not about the gate: only the approval check is switched off on the shared singleton. */
export async function openIdentityGate(): Promise<void> {
  const { identityGateService } = await import('../services/identity-gate.service');
  identityGateService.assertApproved = async () => undefined;
}
