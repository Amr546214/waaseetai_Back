/**
 * Which proxy hops Express may believe when it derives `req.ip` from `X-Forwarded-For`. Driven by the TRUST_PROXY env variable so a topology
 * change is a configuration change, not a code change.
 *
 *  - unset / empty      -> 'uniquelocal' (the safe default, see below);
 *  - 'false' / 'off'    -> false (never read X-Forwarded-For: req.ip is the socket address);
 *  - '2' (an integer)   -> that many hops from the right. Only correct when EVERY request really passes through exactly that many proxies
 *                          (a port that is also published directly lets a caller forge the header), so it is accepted but logged;
 *  - 'loopback,172.23.0.1/32,10.0.0.0/8' -> a list of presets / IPs / CIDR ranges, comma separated. Only addresses in the list are
 *                          trusted proxies; the client is the first address from the right that is NOT in the list.
 *
 * The default 'uniquelocal' (RFC1918 + fc00::/7) is what the confirmed DEV topology needs: a host nginx reaches the container through the
 * Docker bridge gateway (172.x), and a caller with a public address is never trusted, so a forged X-Forwarded-For sent straight to the
 * published port is ignored.
 */
export type TrustProxySetting = boolean | number | string | string[];

export const DEFAULT_TRUST_PROXY: TrustProxySetting = 'uniquelocal';

export function resolveTrustProxy(raw: string | undefined | null): TrustProxySetting {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_TRUST_PROXY;
  const lower = value.toLowerCase();
  if (lower === 'false' || lower === 'off' || lower === 'none') return false;
  if (lower === 'true') return DEFAULT_TRUST_PROXY; // a blanket `true` would trust any forged header: never honoured
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops > 0 ? hops : false;
  }
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length === 1 ? parts[0] : parts;
}
