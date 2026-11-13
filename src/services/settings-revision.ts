import type { Prisma } from "@prisma/client";
import { INSTANCE_ID, SETTINGS_CHANNEL } from "./settings-bus";

export const PUBLIC_REVISION_KEY = "__platform_public_revision";
/** A database-wide commit order. PostgreSQL delivers NOTIFY only when this same transaction commits. */
export async function markSettingsChanged(
  tx: Prisma.TransactionClient,
  keys: string[],
): Promise<number> {
  const r = await tx.platformSetting.upsert({
    where: { key: PUBLIC_REVISION_KEY },
    create: { key: PUBLIC_REVISION_KEY, value: 0, version: 1 },
    update: { version: { increment: 1 } },
  });
  await tx.$executeRaw`SELECT pg_notify(${SETTINGS_CHANNEL}, ${JSON.stringify({ keys, revision: r.version, origin: `tx:${INSTANCE_ID}`, at: Date.now() })})`;
  return r.version;
}
