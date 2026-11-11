/** Accepts fresh raster data only; callers never fetch an arbitrary URL. */
export function parseAdminAvatar(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 2_800_000) throw new Error('INVALID_AVATAR');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new Error('INVALID_AVATAR');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 2 * 1024 * 1024 || buffer.toString('base64') !== match[2]) throw new Error('INVALID_AVATAR');
  const valid = match[1] === 'png' ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'jpeg' ? buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
    : buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('INVALID_AVATAR');
  return value;
}
