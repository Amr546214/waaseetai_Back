/**
 * Prints the REAL endpoint -> guard matrix of every router mounted under /api/admin (read from the live Express router stacks, not from documentation), as Markdown.
 *   DATABASE_URL=<any local url> JWT_SECRET=x OPENAI_API_KEY=x npx tsx scripts/admin-access-matrix.ts > MATRIX.md
 * Needs no database connection (nothing is queried).
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.JWT_SECRET ??= 'x'; process.env.OPENAI_API_KEY ??= 'x';
const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
const imports = new Map<string, { file: string; name: string }>();
for (const m of app.matchAll(/import\s+(\w+)\s+from\s+'(\.\/routes\/[^']+)'/g)) imports.set(m[1], { file: m[2], name: 'default' });
for (const m of app.matchAll(/import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+'(\.\/routes\/[^']+)'/g)) { imports.set(m[1], { file: m[3], name: 'default' }); for (const n of m[2].split(',').map(x => x.trim())) imports.set(n, { file: m[3], name: n }); }
for (const m of app.matchAll(/import\s+\{([^}]+)\}\s+from\s+'(\.\/routes\/[^']+)'/g)) for (const n of m[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop()!)) imports.set(n, { file: m[2], name: n });
const mounts = [...app.matchAll(/mountAppRoute\('\/api\/admin\/([\w-]+)',\s*(\w+)\)/g)].map(m => ({ prefix: m[1], ident: m[2] }));

const label = (h: any): string | null => h.adminPermissions ? `${h.adminPermissions.length > 1 ? 'ALL OF ' : ''}${h.adminPermissions.join(' + ')}`.replace('ALL OF ', 'all of: ') : h.adminSuperAdminOnly ? 'SUPER_ADMIN ONLY' : h.adminScoped ? `scope: ${h.adminScoped} (SUPER_ADMIN, or the dispute / ticket case held)` : h.adminMember ? 'any team member (holds >= 1 permission)' : h.adminSelf ? 'own admin account only' : null;

(async () => {
	const rows: string[] = []; let total = 0;
	for (const { prefix, ident } of mounts) {
		const ref = imports.get(ident); if (!ref) continue;
		const mod: any = await import(ref.file.replace('./routes/', '../src/routes/') + '.ts');
		const router = mod[ref.name]; if (!router) continue;
		let routerGuard: string[] = [];
		for (const layer of router.stack as any[]) {
			if (!layer.route) { const l = label(layer.handle); if (l) routerGuard = [...routerGuard, l]; continue; }
			const own = (layer.route.stack as any[]).map(s => label(s.handle)).filter(Boolean) as string[];
			const guards = [...routerGuard, ...own];
			for (const method of Object.keys(layer.route.methods)) { total++; rows.push(`| ${method.toUpperCase()} | /api/admin/${prefix}${layer.route.path === '/' ? '' : layer.route.path} | ${guards.length ? guards.join(' **and** ') : '**NONE**'} |`); }
		}
	}
	console.log(`# Admin endpoint -> guard matrix (generated from the live routers)\n\n${total} endpoints under /api/admin. Every row must name a guard: there is no \`ADMIN\` / \`SUPER_ADMIN\` account-type row.\n\n| Method | Path | Guard |\n|---|---|---|\n${rows.join('\n')}`);
	process.exit(0);
})();
