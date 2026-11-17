import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Control plane: when CONTROL_PLANE_DATABASE_URL is set (dev only), the admin settings panel of THIS deployment reads and writes the settings
 * stored in that other database (the official site's), while this deployment keeps running on its own local settings. Unset = the panel controls this deployment.
 * Point it at a database role that can only read, write `platform_settings` and insert audit rows, never a full-access role.
 */
export const controlPlaneUrl = (env: NodeJS.ProcessEnv = process.env): string => (env.CONTROL_PLANE_DATABASE_URL || '').trim();
export const controlTarget = (env: NodeJS.ProcessEnv = process.env): 'OFFICIAL' | 'LOCAL' => (controlPlaneUrl(env) ? 'OFFICIAL' : 'LOCAL');

let client: PrismaClient | null = null;
/** the Prisma client of the control database, or null when this deployment controls itself */
export function getControlPrisma(): PrismaClient | null {
	const url = controlPlaneUrl();
	if (!url) return null;
	if (!client) client = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url, max: 3 })) });
	return client;
}
