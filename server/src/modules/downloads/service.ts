import type { Download, PlanTier, User, Video } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { config } from '../../config.js';
import { HttpError } from '../../lib/http.js';
import { PLANS, contentBlock, effectivePlan, type ContentBlock } from '../../lib/plans.js';
import { prisma, transactionWithRetry, type Tx } from '../../lib/prisma.js';
import { istDateKey, istMonthKey, nextIstMidnight } from '../../lib/time.js';

/*
 * Quota rules
 * - A download is charged against the IST day (quotaDate) it was authorized on; daily and monthly
 *   counts are derived from quotaDate, so quotas reset at IST midnight / the first of the IST month.
 * - Re-downloading a video the user already downloaded (charged) within DUPLICATE_DOWNLOAD_WINDOW_HOURS
 *   is free (countsToQuota=false) and isn't blocked by an exhausted quota.
 * - An attempt that fails or is interrupted before a single byte is delivered is refunded
 *   (countsToQuota=false). Once bytes were delivered it stays charged, but it can be retried for free
 *   within the duplicate window.
 * - Retrying a refunded attempt charges quota again (otherwise failed attempts would be an
 *   unlimited free-download loophole).
 * - Quota check + insert run in a transaction that first writes the user's downloadLockSeq. MongoDB
 *   lets only one concurrent transaction write a document; the others abort with a write conflict
 *   and are retried, so simultaneous requests from several devices can't overshoot the limit.
 */

export const TOKEN_TTL_MS = 5 * 60_000;
const REUSE_WINDOW_MS = 2 * 60_000;

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export async function getQuota(user: Pick<User, 'id' | 'plan' | 'planExpiresAt'>, db: Tx = prisma) {
  const plan = effectivePlan(user);
  const features = PLANS[plan];
  const today = istDateKey();
  const month = istMonthKey();
  const [usedToday, usedMonth] = await Promise.all([
    db.download.count({ where: { userId: user.id, countsToQuota: true, quotaDate: today } }),
    db.download.count({ where: { userId: user.id, countsToQuota: true, quotaDate: { startsWith: month } } }),
  ]);
  return {
    plan,
    planExpired: user.plan !== 'FREE' && plan === 'FREE',
    dailyLimit: features.downloadsPerDay,
    monthlyLimit: features.downloadsPerMonth,
    usedToday,
    usedThisMonth: usedMonth,
    remainingToday: Math.max(0, features.downloadsPerDay - usedToday),
    remainingThisMonth: Math.max(0, features.downloadsPerMonth - usedMonth),
    resetsAt: nextIstMidnight(),
    duplicateWindowHours: config.downloads.duplicateWindowHours,
  };
}

export type Quota = Awaited<ReturnType<typeof getQuota>>;

/** Checks that don't depend on quota: plan includes downloads, video access, registered device. */
const BLOCK_MESSAGES: Record<ContentBlock, string> = {
  EXCLUSIVE_REQUIRED: 'Exclusive premium courses are part of the Gold plan',
  EARLY_ACCESS: 'This new release is in early access for Gold members',
  PREMIUM_REQUIRED: 'Premium videos need a paid plan',
};

export async function assertCanDownload(user: User, video: Video | null, deviceKey: string | null) {
  if (!video) throw new HttpError(404, 'Video not found', 'NOT_FOUND');
  if (!video.isDownloadable) throw new HttpError(403, 'This video can’t be downloaded', 'NOT_DOWNLOADABLE');

  const plan = effectivePlan(user);
  const expired = user.plan !== 'FREE' && plan === 'FREE';
  if (!PLANS[plan].offlineDownloads) throw new HttpError(403, 'Your plan doesn’t include downloads', 'PREMIUM_REQUIRED');
  const block = contentBlock(plan, video);
  if (block) {
    if (expired) throw new HttpError(403, 'Your subscription has expired. Renew to download this video.', 'PLAN_EXPIRED');
    throw new HttpError(403, BLOCK_MESSAGES[block], block);
  }

  if (config.downloads.requireRegisteredDevice) {
    const device = deviceKey
      ? await prisma.trustedDevice.findUnique({ where: { userId_deviceKey: { userId: user.id, deviceKey } } })
      : null;
    if (!device || device.revokedAt || !device.downloadsEnabled || device.trustedUntil < new Date()) {
      throw new HttpError(403, 'Downloads are only allowed on your registered devices', 'DEVICE_NOT_REGISTERED');
    }
  }
}

/** Per-user mutex: concurrent transactions that both write this user document conflict, one retries. */
function lockUser(tx: Tx, userId: string) {
  return tx.user.update({ where: { id: userId }, data: { downloadLockSeq: { increment: 1 } }, select: { id: true } });
}

async function chargedRecently(tx: Tx, userId: string, videoId: string, excludeId?: string) {
  const since = new Date(Date.now() - config.downloads.duplicateWindowHours * 3_600_000);
  const hit = await tx.download.findFirst({
    where: { userId, videoId, countsToQuota: true, createdAt: { gte: since }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true },
  });
  return !!hit;
}

function assertQuotaLeft(quota: Quota) {
  if (quota.remainingToday > 0 && quota.remainingThisMonth > 0) return;
  if (quota.planExpired) {
    throw new HttpError(403, 'Your subscription has expired and the Free daily limit is used up. Renew to keep downloading.', 'PLAN_EXPIRED', { quota });
  }
  if (quota.remainingThisMonth <= 0) {
    throw new HttpError(403, `You’ve used all ${quota.monthlyLimit} downloads for this month`, 'MONTHLY_LIMIT', { quota });
  }
  throw new HttpError(403, `You’ve used all ${quota.dailyLimit} downloads for today`, 'DAILY_LIMIT', { quota });
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string;
  browser: string | null;
  os: string | null;
  deviceType: string;
  deviceKey: string | null;
}

/** Authorize a new download (or hand back the one just authorized, for double clicks / refreshes). */
export async function authorizeDownload(user: User, video: Video, meta: RequestMeta) {
  return transactionWithRetry(async (tx) => {
    await lockUser(tx, user.id);

    const recent = await tx.download.findFirst({
      where: {
        userId: user.id,
        videoId: video.id,
        status: { in: ['AUTHORIZED', 'IN_PROGRESS'] },
        createdAt: { gte: new Date(Date.now() - REUSE_WINDOW_MS) },
        tokenExpiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) return { download: recent, quota: await getQuota(user, tx), reused: true };

    const duplicate = await chargedRecently(tx, user.id, video.id);
    if (!duplicate) assertQuotaLeft(await getQuota(user, tx));

    const download = await tx.download.create({
      data: {
        userId: user.id,
        videoId: video.id,
        plan: effectivePlan(user),
        countsToQuota: !duplicate,
        token: newToken(),
        tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        fileSizeBytes: video.fileSizeBytes,
        quotaDate: istDateKey(),
        ...meta,
      },
    });
    return { download, quota: await getQuota(user, tx), reused: false };
  });
}

/** Fresh token for an interrupted/failed download. */
export async function retryDownload(user: User, original: Download & { video: Video }, meta: RequestMeta) {
  if (!['INTERRUPTED', 'FAILED'].includes(original.status)) {
    throw new HttpError(409, 'Only interrupted or failed downloads can be retried', 'NOT_RETRYABLE');
  }
  const windowMs = config.downloads.duplicateWindowHours * 3_600_000;
  if (Date.now() - original.createdAt.getTime() > windowMs) {
    throw new HttpError(409, 'This download is too old to retry — start a new download instead', 'RETRY_EXPIRED');
  }
  await assertCanDownload(user, original.video, meta.deviceKey);

  return transactionWithRetry(async (tx) => {
    await lockUser(tx, user.id);
    let charge = false;
    if (!original.countsToQuota) {
      // Refunded attempt: charge again unless another charged copy is within the window.
      charge = !(await chargedRecently(tx, user.id, original.videoId, original.id));
      if (charge) assertQuotaLeft(await getQuota(user, tx));
    }
    const download = await tx.download.update({
      where: { id: original.id },
      data: {
        status: 'AUTHORIZED',
        token: newToken(),
        tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        failureReason: null,
        bytesSent: 0n,
        ...(charge ? { countsToQuota: true, quotaDate: istDateKey(), plan: effectivePlan(user) } : {}),
        ...meta,
      },
    });
    return { download, quota: await getQuota(user, tx) };
  });
}

/** Re-validate the subscription when the file is actually fetched. */
export function assertPlanStillValid(user: User, download: Download, video: Video) {
  const plan = effectivePlan(user);
  if (download.plan !== 'FREE' && plan === 'FREE') {
    throw new HttpError(403, 'Your subscription expired after this download was authorized', 'PLAN_EXPIRED');
  }
  const block = contentBlock(plan, video);
  if (block) throw new HttpError(403, BLOCK_MESSAGES[block], block);
}

/** Downloads currently streaming in this process — lets the sweeper tell "stalled" from "active". */
export const activeStreams = new Set<string>();

export function planLabel(plan: PlanTier) {
  return PLANS[plan].name;
}
