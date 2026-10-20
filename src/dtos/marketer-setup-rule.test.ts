import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateMarketingInfoSchema, addChannelSchema } from './marketer-profile.dto';
import { marketingChannelProblem } from '../utils/marketing-channel-validation';

// Marketer setup (owner decision): the bio is REQUIRED and at least ONE VALID marketing channel is required; no platform is forced and one is enough.
// The rule applies to the wizard (`setup: true`); ordinary partial updates (avatar only, a bio edit elsewhere) keep their lenient rules.
const bioIssue = (r: any) => r.error?.issues.find((i: any) => i.path[0] === 'bio')?.message;

test('setup bio: whitespace-only / empty / invisible-only / tags-only is refused under the bio field; a real bio passes', () => {
	for (const bio of ['', '   ', ' ​ ', '<b></b>', '<script></script> ', null, undefined]) {
		const r: any = updateMarketingInfoSchema.safeParse({ bio, setup: true });
		assert.equal(r.success, false, JSON.stringify(bio));
		assert.equal(bioIssue(r), 'الوصف التسويقي مطلوب');
	}
	assert.equal(updateMarketingInfoSchema.safeParse({ bio: 'وصف قصير', setup: true }).success, true);
	assert.equal(updateMarketingInfoSchema.safeParse({ bio: 'x'.repeat(501), setup: true }).success, false);
});

test('without `setup` nothing changes: avatar-only, empty bio and null bio stay valid (unrelated partial updates are not blocked)', () => {
	assert.equal(updateMarketingInfoSchema.safeParse({ avatarUrl: 'data:image/png;base64,AAAA' }).success, true);
	assert.equal(updateMarketingInfoSchema.safeParse({ bio: '' }).success, true);
	assert.equal(updateMarketingInfoSchema.safeParse({ bio: null }).success, true);
	assert.equal(updateMarketingInfoSchema.safeParse({ bio: 'x', setup: false }).success, true);
});

test('setup channel: valid handles / links / WhatsApp numbers pass, whatever the platform (no platform is forced)', () => {
	const ok: [string, string][] = [['INSTAGRAM', '@amr.okasha'], ['INSTAGRAM', 'https://www.instagram.com/amr'], ['YOUTUBE', 'https://youtu.be/abc'], ['YOUTUBE', 'youtube.com/@chan'],
		['TIKTOK', 'user_1'], ['TWITTER', 'https://x.com/amr'], ['LINKEDIN', 'https://linkedin.com/in/amr'], ['WHATSAPP', '+966500000000'], ['WHATSAPP', 'https://wa.me/966500000000'], ['LINKEDIN', 'amr-okasha']];
	for (const [platform, handle] of ok) assert.equal(addChannelSchema.safeParse({ platform, handle, setup: true }).success, true, `${platform} ${handle}`);
});

test('setup channel: empty / spaces / malformed / foreign-domain / script values are refused under the handle field with a specific message', () => {
	const bad: [string, string, RegExp][] = [
		['INSTAGRAM', '', /مطلوب/], ['INSTAGRAM', '   ', /مطلوب/], ['TIKTOK', 'my channel', /مسافات/],
		['INSTAGRAM', 'https://evil.example/amr', /لا يخص/], ['YOUTUBE', 'https://www.instagram.com/amr', /لا يخص/], ['TWITTER', 'https://', /غير صالح/],
		['WHATSAPP', 'abc', /واتساب/], ['WHATSAPP', '12345', /واتساب/], ['INSTAGRAM', 'javascript:alert(1)', /غير صالح/], ['INSTAGRAM', 'ftp://instagram.com/x', /http/],
	];
	for (const [platform, handle, re] of bad) {
		const r: any = addChannelSchema.safeParse({ platform, handle, setup: true });
		assert.equal(r.success, false, `${platform} ${handle}`);
		assert.equal(r.error.issues.find((i: any) => i.path[0] === 'handle')?.message.match(re) !== null, true, `${platform} ${handle}: ${JSON.stringify(r.error.issues[0].message)}`);
	}
	assert.equal((addChannelSchema.safeParse({ platform: 'MYSPACE', handle: 'x', setup: true }) as any).success, false);
	assert.equal((addChannelSchema.safeParse({ platform: 'INSTAGRAM', handle: 'x', url: 'javascript:alert(1)', setup: true }) as any).success, false);
});

test('without `setup` the existing lenient channel rule is untouched (a one-character handle on any platform)', () => {
	for (const platform of ['LINKEDIN', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'TWITTER', 'INSTAGRAM']) assert.equal(addChannelSchema.safeParse({ platform, handle: 'x' }).success, true, platform);
});

test('marketingChannelProblem is the single rule (null = valid)', () => {
	assert.equal(marketingChannelProblem('INSTAGRAM', '@ok'), null);
	assert.notEqual(marketingChannelProblem('INSTAGRAM', ''), null);
	assert.equal(marketingChannelProblem('UNKNOWN', 'x'), null);
});
