import { LoginGuardService } from '/Users/amrokasha/Desktop/Waseet-Audit/wta/nb-be/src/services/login-guard.service';
import { systemSettingsService } from '/Users/amrokasha/Desktop/Waseet-Audit/wta/nb-be/src/services/system-settings.service';
import { prisma } from '/Users/amrokasha/Desktop/Waseet-Audit/wta/nb-be/src/config/db';
(async () => {
	(systemSettingsService as any).get = async (k: string) => ({ loginMaxFailedAttempts: 3, loginAttemptWindowMinutes: 15, loginBlockMinutes: 10, loginIpMaxFailedAttempts: 5 } as any)[k];
	const g = new LoginGuardService(prisma as any); const out: any = {};
	const A = { ip: '203.0.113.5', email: 'victim@x.com' };
	for (let i = 0; i < 2; i++) await g.recordFailure(A);
	out.after2 = await g.check(A);
	await g.recordFailure(A); out.after3 = await g.check(A);
	out.otherIpSameAccount = await g.check({ ip: '203.0.113.99', email: 'victim@x.com' }); // the owner elsewhere is NOT blocked
	out.sameIpOtherAccount = await g.check({ ip: '203.0.113.5', email: 'other@x.com' });
	for (const e of ['a@x.com', 'b@x.com']) await g.recordFailure({ ip: '203.0.113.5', email: e }); // 3 + 2 = 5 failures from the address -> IP block
	out.ipBlocked = await g.check({ ip: '203.0.113.5', email: 'brandnew@x.com' });
	out.list = (await g.listBlocks()).map(b => [b.scope, b.ip, b.account]);
	out.impact = await g.impact({ maxFails: 2 });
	const ip = (await g.listBlocks()).find(b => b.scope === 'IP')!; out.unblock = await g.unblock(ip.id, 'admin-1'); out.afterUnblock = await g.check({ ip: '203.0.113.5', email: 'brandnew@x.com' });
	await g.recordSuccess({ ip: '198.51.100.1', email: 'ok@x.com' }); await g.recordFailure({ ip: '198.51.100.1', email: 'ok@x.com' }); await g.recordSuccess({ ip: '198.51.100.1', email: 'ok@x.com' });
	out.successClears = (await prisma.$queryRawUnsafe<any[]>(`select count(*)::int c from login_guard_state where key like 'p:198.51.100.1|%'`))[0].c;
	console.log(JSON.stringify(out, null, 1)); await prisma.$executeRawUnsafe(`delete from login_guard_state`); await prisma.$disconnect();
})();
