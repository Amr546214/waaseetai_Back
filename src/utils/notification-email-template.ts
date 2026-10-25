import { emailButton, escHtml, MAIL_FONT, renderEmailShell } from './email-shell';
import { brandName } from './brand';

export interface NotificationEmailInput {
	lang: 'ar' | 'en';
	greeting: string;
	title: string;
	message: string;
	/** ABSOLUTE url (from siteUrl) or null: with no link there is no button, never a host-less one. */
	linkUrl: string | null;
	ctaLabel: string;
	footerNote: string;
}

/**
 * The notification mail (new project opportunity, offer, status ...): the shared light shell, a centered greeting + title + message and one clear solid button.
 * The notification's title / message are shown as authored (escaped).
 */
export const buildNotificationEmailHtml = (i: NotificationEmailInput): string => {
	const bodyHtml = `      ${i.greeting ? `<div style="font-family:${MAIL_FONT};font-size:13px;line-height:20px;color:#6b7280;margin:0 0 10px 0;">${escHtml(i.greeting)}</div>` : ''}
      <div style="font-family:${MAIL_FONT};font-size:18px;line-height:28px;font-weight:700;color:#111827;margin:0 0 10px 0;">${escHtml(i.title)}</div>
      <div style="font-family:${MAIL_FONT};font-size:14px;line-height:23px;color:#374151;margin:0 0 ${i.linkUrl ? '24px' : '4px'} 0;">${escHtml(i.message)}</div>
      ${i.linkUrl ? emailButton(i.linkUrl, i.ctaLabel) : ''}`;
	return renderEmailShell({ lang: i.lang, docTitle: `${i.title} - ${brandName()}`, bodyHtml, footerNote: i.footerNote });
};
