import type { Server } from 'socket.io';
import { systemSettingsService } from './system-settings.service';
import { MAINTENANCE_DEFAULT_MESSAGE } from '../utils/platform-defaults';

export const PLATFORM_STATE_EVENT = 'platform:state';
export interface PlatformState { maintenance: { on: boolean; message: string }; revision: number; at: number }
const COLD_MSG = 'المنصة تتحقق من حالتها بعد التشغيل. حاول بعد لحظات.';

/** the public, secret-free state every browser needs: whether the Under Deployment page is up and what it says */
export async function publicPlatformState(): Promise<PlatformState> {
 const s = await systemSettingsService.publicSnapshot();
 const text = String(s.data.maintenanceBannerText || '').trim();
 const on = s.trusted ? s.data.maintenanceMode === true : process.env.MAINTENANCE_COLD_BOOT_POLICY !== 'open';
 return { maintenance: { on, message: on ? (text || (s.trusted ? MAINTENANCE_DEFAULT_MESSAGE : COLD_MSG)) : '' }, revision: s.revision, at: Date.now() };
}
export async function broadcastPlatformState(io: Server | null | undefined): Promise<void> { if (io) io.emit(PLATFORM_STATE_EVENT, await publicPlatformState()); }
