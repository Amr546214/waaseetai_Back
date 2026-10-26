/**
 * The platform currency of this release (multi-currency is deferred, so there is exactly one). Money code that writes or reports an amount in the platform currency (contract terms, admin finance,
 * provider finance...) and the settings view (`baseCurrency` row: the value shown to the admin) read THIS constant; the settings view never invents its own.
 */
export const PLATFORM_CURRENCY = 'USD' as const;
/** how the currency is written for people in the settings screen */
export const PLATFORM_CURRENCY_NAME_AR = 'دولار أمريكي';
