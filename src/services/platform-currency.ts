import { systemSettingsService } from './system-settings.service';
import { Currency, LEGACY_CURRENCY, isSupportedCurrency } from '../utils/currency';

/**
 * The currency a NEW root record (a request, a service, a coupon) is created in: the platform base-currency setting. Everything created from it (proposals, offers, contracts, stages, escrows,
 * amendments) inherits THAT record's currency, never this setting, so changing the setting later never moves an existing operation. A setting that cannot be read means the legacy currency (USD).
 */
export async function platformCurrency(): Promise<Currency> {
	try { const v = await systemSettingsService.get<string>('baseCurrency'); return isSupportedCurrency(v) ? v : LEGACY_CURRENCY; } catch { return LEGACY_CURRENCY; }
}
