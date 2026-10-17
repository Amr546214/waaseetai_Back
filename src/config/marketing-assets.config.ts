/**
 * Admin-published marketing material (banners, templates, files) a marketer can download. There is NO admin-managed store for it yet (no table, no upload screen), so this
 * list is the single source and it ships EMPTY: the marketer page then says honestly that nothing has been published. An entry must point at a real https file.
 */
export type MarketingAssetKind = 'BANNER' | 'TEMPLATE' | 'FILE';

export interface MarketingAsset {
  id: string;
  kind: MarketingAssetKind;
  title: string;
  description?: string;
  /** A real https URL of the file; the marketer opens / downloads it from there. */
  downloadUrl: string;
}

export const MARKETING_ASSETS: MarketingAsset[] = [];
