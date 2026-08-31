export function generateReferralSlug(fullName: string | undefined | null, userId: string): string {
  const sanitized = (fullName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  
  const namePart = sanitized.length > 0 ? sanitized : 'user';
  const shortId = userId.slice(-4);
  
  return `${namePart}${shortId}`;
}
