// Stored reference to a PRIVATE (Cloudinary type=authenticated) KYC asset. It lives in the same String columns that used to hold a public URL,
// so no schema change is needed:   private:<resource_type>:<format|->:<public_id>
// It is never returned by any API response (see scrub-private-refs.middleware.ts); the only way to read the file is the access-link endpoint.

export const PRIVATE_REF_PREFIX = 'private:';
export type PrivateResourceType = 'image' | 'video' | 'raw';
export interface ParsedPrivateRef { resourceType: PrivateResourceType; format: string | null; publicId: string }

const REF_PATTERN = /^private:(image|video|raw):([A-Za-z0-9]{1,10}|-):(waseetai(?:\/[A-Za-z0-9_-]+)+)$/;

export function isPrivateRef(value: unknown): boolean {
	return typeof value === 'string' && value.startsWith(PRIVATE_REF_PREFIX);
}

export function buildPrivateRef(ref: { resourceType: PrivateResourceType; format?: string | null; publicId: string }): string {
	return `${PRIVATE_REF_PREFIX}${ref.resourceType}:${ref.format || '-'}:${ref.publicId}`;
}

export function parsePrivateRef(value: string): ParsedPrivateRef | null {
	const m = REF_PATTERN.exec(value);
	if (!m) return null;
	return { resourceType: m[1] as PrivateResourceType, format: m[2] === '-' ? null : m[2], publicId: m[3] };
}

/** A user may only echo back a reference that sits inside their own folder (…/<userId>/…). */
export function privateRefBelongsTo(value: string, userId: string): boolean {
	const parsed = parsePrivateRef(value);
	return !!parsed && !!userId && parsed.publicId.split('/').includes(userId);
}
