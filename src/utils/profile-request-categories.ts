/** Category of a client's governed-field modification request (profile_modification_requests.category). Shared by the client edit flow and the admin review. */
export const CLIENT_IDENTITY_REQUEST_CATEGORY = 'CLIENT_IDENTITY';

/** A client's display name (first / last name) change from the "البيانات الأساسية" tab: never applied directly, an admin approves it first. */
export const CLIENT_BASIC_INFO_REQUEST_CATEGORY = 'CLIENT_BASIC_INFO';

/** A client's password-change request: the new password is stored only as a bcrypt hash (metadata.pendingPasswordHash, never returned) and applied when an admin approves. */
export const CLIENT_PASSWORD_CHANGE_REQUEST_CATEGORY = 'CLIENT_PASSWORD_CHANGE';
