import { MARKETING_ASSETS, type MarketingAsset } from '../config/marketing-assets.config';
import { prisma } from '../config/db';
import { isMissingTableError } from '../utils/missing-table';

export interface MarketerAssetItem {
  id: string;
  kind: MarketingAsset['kind'] | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LINK' | 'TEXT';
  title: string;
  description: string | null;
  /** A real https file the marketer opens or downloads. */
  downloadUrl: string | null;
  /** Copy-ready text for TEXT materials (captions, messages); null for files and links. */
  text?: string | null;
}

/** Only an https URL can be offered as a download; anything else in the config is dropped rather than shown as a dead link. */
const isRealFileUrl = (url: unknown): url is string => typeof url === 'string' && /^https:\/\/[^\s]+$/i.test(url);

export const marketerAssetsService = {
  /**
   * The files an admin published for marketers (MARKETING_ASSETS, empty until something is published). No banner or template is ever invented: an empty list is
   * the honest answer and the page says so. The marketer's own referral links are a separate, already-real endpoint (/ref-links).
   */
  list(source: MarketingAsset[] = MARKETING_ASSETS): { items: MarketerAssetItem[] } {
    return {
      items: source.filter(a => isRealFileUrl(a.downloadUrl)).map(a => ({ id: a.id, kind: a.kind, title: a.title, description: a.description ?? null, downloadUrl: a.downloadUrl }))
    };
  },

  /**
   * What the marketer page serves: the active materials an admin published in the managed store (audience MARKETER or ALL). A database that has not received the
   * marketing_assets table yet answers an empty list (the page shows its honest empty state), never an error.
   */
  async listForMarketer(): Promise<{ items: MarketerAssetItem[] }> {
    try {
      const rows = await prisma.marketingAsset.findMany({ where: { active: true, audience: { in: ['MARKETER', 'ALL'] } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }] });
      const items: MarketerAssetItem[] = [];
      for (const r of rows) {
        const url = isRealFileUrl(r.fileUrl) ? r.fileUrl : isRealFileUrl(r.linkUrl) ? r.linkUrl : null;
        const text = r.kind === 'TEXT' ? r.text ?? null : null;
        if (!url && !text) continue;
        items.push({ id: r.id, kind: r.kind as MarketerAssetItem['kind'], title: r.title, description: r.description ?? null, downloadUrl: url, text });
      }
      return { items };
    } catch (error) {
      if (isMissingTableError(error)) return { items: [] };
      throw error;
    }
  }
};
