/**
 * Prints the settings inventory and the "setting -> where used -> effect -> proof" matrix straight from the registry (so the document can never drift from the code):
 *   npx tsx scripts/system-settings-matrix.ts > SETTINGS-INVENTORY.generated.md
 */
import { SETTING_DEFS } from '../src/config/system-settings.registry';

const perm = (p: string) => (p === 'SUPER' ? 'Super Admin فقط' : p === 'settings.view' ? 'settings.view' : 'settings.manage');
const label = { enforced: 'يعمل (مفروض من الخادم)', readonly: 'قيمة فعلية للعرض فقط', blocked: 'غير متاح / غير منفّذ' } as const;
const pages = (p: string[]) => p.map(x => x.replace('P-AD-', '')).join('، ');
const out: string[] = [];
const count = (s: string) => SETTING_DEFS.filter(d => d.status === s).length;
out.push('# جرد إعدادات النظام (مولَّد من السجل المركزي: src/config/system-settings.registry.ts)');
out.push('');
out.push(`الإجمالي ${SETTING_DEFS.length}: يعمل ${count('enforced')} · قيمة فعلية للعرض ${count('readonly')} · غير متاح ${count('blocked')}.`);
out.push('');
for (const st of ['enforced', 'readonly', 'blocked'] as const) {
	out.push(`## ${label[st]}`);
	out.push('');
	if (st === 'enforced') {
		out.push('| المفتاح | المعنى | الصفحة | القسم | القراءة | التعديل | وقت السريان | من يقرؤه/أين يُفرض | الاختبار |');
		out.push('|---|---|---|---|---|---|---|---|---|');
		for (const d of SETTING_DEFS.filter(x => x.status === st)) out.push(`| \`${d.key}\` | ${d.label}: ${d.description.replace(/\|/g, '/')} | ${pages(d.pages)} | ${d.tab} | ${perm(d.read)} | ${perm(d.write)} | ${d.effect} | ${d.consumers.join('؛ ')} | ${d.proof ?? ''} |`);
	} else {
		out.push('| المفتاح | المعنى | الصفحة | القسم | السبب / مصدر القيمة |');
		out.push('|---|---|---|---|---|');
		for (const d of SETTING_DEFS.filter(x => x.status === st)) { const cur = d.current ? d.current() : null; out.push(`| \`${d.key}\` | ${d.label} | ${pages(d.pages)} | ${d.tab} | ${(d.reason ?? '').replace(/\|/g, '/')}${cur ? ` — القيمة الحالية: ${typeof cur.value === 'object' ? 'حالة فقط' : String(cur.value)} (${cur.source})` : ''} |`); }
	}
	out.push('');
}
console.log(out.join('\n'));
