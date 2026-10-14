import { MARKETING_ASSETS, type MarketingAsset } from '../config/marketing-assets.config';

export interface MarketerAssetItem {
  id: string;
  kind: MarketingAsset['kind'];
  title: string;
  description: string | null;
  /** A real https file the marketer opens or downloads. */
  downloadUrl: string;
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
  }
};
