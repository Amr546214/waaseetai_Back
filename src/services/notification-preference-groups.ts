/**
 * Per-type notification switches (the settings pages of client and provider). One shared map per user (notification_preferences.settings), the key is the switch.
 * A switch the user turned OFF (`false`) silences every notification of its types: nothing is stored in the inbox, pushed or mailed. Missing / true = on.
 * Notifications that are not listed (disputes, identity / KYC, support, security, admin messages, ...) can never be switched off here.
 */
export type NotificationGroupKey = 'newOffer' | 'requestStatus' | 'newMessage' | 'walletActivity' | 'cashback';

const GROUP_TYPES: Record<NotificationGroupKey, readonly string[]> = {
	newOffer: ['NEW_PROPOSAL', 'OFFER_WITHDRAWN', 'OFFER_COUNTER', 'OFFER_COUNTER_DECLINED', 'OFFER_COUNTER_ACCEPTED', 'OFFER_NEGOTIATION_REQUESTED', 'OFFER_NEGOTIATION_REJECTED', 'OFFER_SELECTED', 'OFFER_ACCEPTED', 'PROJECT_MATCH', 'NEW_CLIENT_REQUEST'],
	requestStatus: ['PROJECT_AMENDMENT', 'STAGE_DELIVERY', 'STAGE_APPROVED', 'STAGE_REVIEW', 'PROJECT_COMPLETED', 'PROJECT_CANCELLATION', 'SERVICE_PURCHASED', 'RATING_RECEIVED'],
	newMessage: ['CHAT', 'MEETING_REQUEST'],
	walletActivity: ['ESCROW_FUNDED', 'ESCROW_LOCK', 'DEPOSIT', 'REFUND', 'GAIN', 'STAGE_RELEASE', 'PROJECT_COMPLETION_REWARD', 'WITHDRAWAL'],
	cashback: ['CASHBACK_CREDITED'],
};

const TYPE_TO_GROUP: ReadonlyMap<string, NotificationGroupKey> = new Map(
	(Object.entries(GROUP_TYPES) as Array<[NotificationGroupKey, readonly string[]]>).flatMap(([key, types]) => types.map(t => [t, key] as const)),
);

/** The switch a notification type belongs to (WITHDRAWAL_<event> belongs to the wallet switch); null = not switchable. */
export const preferenceGroupOf = (type: string | null | undefined): NotificationGroupKey | null => {
	if (!type) return null;
	if (type.startsWith('WITHDRAWAL_')) return 'walletActivity';
	return TYPE_TO_GROUP.get(type) ?? null;
};

/** true only when the user explicitly turned the notification's switch off. */
export const isMutedBySettings = (settings: unknown, type: string | null | undefined): boolean => {
	const group = preferenceGroupOf(type);
	if (!group || !settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
	return (settings as Record<string, unknown>)[group] === false;
};
