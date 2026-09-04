import { Request } from 'express';

export function getRequestCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;

    const rawValue = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }

  return undefined;
}

export function getAuthCookie(req: Request): string | undefined {
  return getRequestCookie(req, 'waseet_token')
    || getRequestCookie(req, 'token')
    || getRequestCookie(req, 'access_token');
}
