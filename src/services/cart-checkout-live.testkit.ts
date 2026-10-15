/**
 * Mock rows for the live-service re-validation that init / resend / confirm run (ownership + availability): every requested service id exists, is market
 * visible and is owned by `ownerId`, so tests that are not about self-purchase keep their original behaviour.
 */
export function liveServices(ownerId = 'provider-1') {
  return async (args: any) => {
    const ids: string[] | undefined = args?.where?.id?.in;
    if (!ids || !args?.select) return [];
    return ids.map(id => ({ id, providerId: ownerId }));
  };
}
