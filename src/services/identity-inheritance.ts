/**
 * ONE PERSON, ONE VERIFIED IDENTITY. When an account adds another role, an identity that an administrator already APPROVED on one of its other roles is carried over
 * to the new role's profile as it stands (document, number, birth date and the approval digest), so the person is never asked to upload and be reviewed again.
 *  - Only a really approved identity is carried (kycStatus VERIFIED with its approval digest); a pending, rejected or missing one is never copied.
 *  - It never creates an approval: it reproduces the existing one. If the evidence changes later on either role, that role's own gate cancels it as usual.
 *  - The identity claim (one identity, one account) belongs to the user, so nothing changes there.
 */
export type InheritSource = 'CLIENT' | 'PROVIDER';

const SELECT = { idNumber: true, idIssuingCountry: true, idDocumentType: true, dob: true, frontIdUrl: true, backIdUrl: true, kycStatus: true, identityApprovedDigest: true, country: true, city: true } as const;

/** profile columns to seed the NEW role with, or {} when no other role of the user holds an approved identity */
export async function approvedIdentityFields(tx: any, userId: string, target: InheritSource): Promise<Record<string, unknown>> {
  const sources: Array<'clientProfile' | 'providerProfile'> = target === 'PROVIDER' ? ['clientProfile'] : ['providerProfile'];
  for (const model of sources) {
    const p = await tx[model].findUnique({ where: { userId }, select: SELECT });
    if (!p || p.kycStatus !== 'VERIFIED' || !p.identityApprovedDigest || !p.frontIdUrl || !(p.idNumber ?? '').trim()) continue;
    return {
      idNumber: p.idNumber, idIssuingCountry: p.idIssuingCountry, idDocumentType: p.idDocumentType, dob: p.dob,
      frontIdUrl: p.frontIdUrl, backIdUrl: p.backIdUrl, kycStatus: 'VERIFIED', identityApprovedDigest: p.identityApprovedDigest,
      ...(target === 'PROVIDER' ? { isVerified: true } : {}),
      ...(p.country ? { country: p.country } : {}), ...(p.city ? { city: p.city } : {}),
    };
  }
  return {};
}
