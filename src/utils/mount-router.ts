import type { RequestHandler, Router } from 'express';

/** Same Express registration/order, with the mount prefix retained for
 * OpenAPI. Express 5 keeps path matchers in closures instead of layer.regexp.
 * This metadata is read by documentation only, never by request handling.
 */
export function mountRouter(parent: Router, prefix: string, ...handlers: RequestHandler[]): Router {
  const before = parent.stack.length;
  parent.use(prefix, ...handlers);
  for (const layer of parent.stack.slice(before)) {
    (layer as unknown as { __swaggerPath?: string }).__swaggerPath = prefix;
  }
  return parent;
}
