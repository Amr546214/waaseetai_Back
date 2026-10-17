// Bounded LOCAL load measurement of the global limiter (never run against dev): old vs new middleware on a tiny in-process express app.
//   node --import tsx scripts/measure-rate-limit-load.ts new   ("old" needs the pre-change middleware restored as src/middlewares/zz-old-rate-limit.tmp.ts: git show <base>:src/middlewares/rate-limit.middleware.ts)
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'load-secret';
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RL_BROWSE_USER = '100000000'; process.env.RL_BROWSE_IP_NET = '100000000'; process.env.RL_BROWSE_IP = '100000000';

(async () => {
  const which = process.argv[2] === 'old' ? 'old' : 'new';
  const mod: any = which === 'old' ? await import('../src/middlewares/zz-old-rate-limit.tmp') : await import('../src/middlewares/rate-limit.middleware');
  const app = express(); app.set('trust proxy', 'loopback');
  // huge cap for the OLD limiter too, so we measure per-request overhead and not rejection
  app.use(which === 'old' ? ((await import('express-rate-limit')).default)({ windowMs: 900000, limit: 1e9, standardHeaders: true, legacyHeaders: false }) : mod.apiLimiter);
  app.get('/api/x', (_q, r) => { r.json({ ok: true }); });
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = (server.address() as any).port;
  const tokens = Array.from({ length: 20 }, (_, i) => jwt.sign({ userId: `u${i}` }, 'load-secret', { expiresIn: '1h' }));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });
  const N = 20000, C = 50; let sent = 0, ok = 0; const lat: number[] = [];
  const cpu0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
  const one = () => new Promise<void>((resolve) => {
    const i = sent++; const s = process.hrtime.bigint();
    const req = http.get({ port, host: '127.0.0.1', path: '/api/x', agent, headers: { authorization: `Bearer ${tokens[i % 20]}`, 'x-forwarded-for': `10.0.${i % 50}.1` } }, (res) => {
      res.resume(); res.on('end', () => { lat.push(Number(process.hrtime.bigint() - s) / 1e6); if (res.statusCode === 200) ok++; resolve(); });
    });
    req.on('error', () => resolve());
  });
  await Promise.all(Array.from({ length: C }, async () => { while (sent < N) await one(); }));
  const secs = Number(process.hrtime.bigint() - t0) / 1e9; const cpu = process.cpuUsage(cpu0);
  lat.sort((a, b) => a - b);
  const q = (p: number) => lat[Math.floor(lat.length * p)].toFixed(2);
  console.log(JSON.stringify({ which, requests: N, ok200: ok, concurrency: C, seconds: +secs.toFixed(2), rps: Math.round(N / secs), p50ms: q(0.5), p95ms: q(0.95), p99ms: q(0.99), cpuUserMs: Math.round(cpu.user / 1000), cpuSysMs: Math.round(cpu.system / 1000), rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
  agent.destroy(); server.closeAllConnections(); server.close(); process.exit(0);
})();
