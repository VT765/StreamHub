import type { Request, Response } from 'express';
import { Router } from 'express';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import path from 'node:path';
import type { User, Video } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { MEDIA_DIR } from '../../lib/paths.js';
import { contentBlock, effectivePlan, planFeatures, type ContentBlock } from '../../lib/plans.js';
import { prisma } from '../../lib/prisma.js';
import { istDateKey } from '../../lib/time.js';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';

export const router = Router();
router.use(optionalAuth);

/** A video counts as completed once this share of it has been watched. */
export const COMPLETE_PERCENT = 90;
/** Max watch seconds credited per progress call (client saves every ~10s). */
const MAX_DELTA_PER_CALL = 30;

type AccessReason = ContentBlock | 'DAILY_LIMIT' | 'SIGN_IN' | null;

interface Access {
  allowed: boolean;
  reason: AccessReason;
  /** null = unlimited (or guest). */
  remainingWatchSeconds: number | null;
}

async function remainingWatchSeconds(user: User): Promise<number | null> {
  const limit = planFeatures(user).dailyWatchMinutes;
  if (limit === null) return null;
  const usage = await prisma.dailyUsage.findUnique({
    where: { userId_date: { userId: user.id, date: istDateKey() } },
  });
  return Math.max(0, limit * 60 - (usage?.watchSeconds ?? 0));
}

async function computeAccess(user: User | undefined, video: Video): Promise<Access> {
  const gated = video.isPremium || video.isExclusive || (!!video.earlyAccessUntil && video.earlyAccessUntil > new Date());
  if (gated) {
    if (!user) return { allowed: false, reason: 'SIGN_IN', remainingWatchSeconds: null };
    const block = contentBlock(effectivePlan(user), video);
    if (block) return { allowed: false, reason: block, remainingWatchSeconds: null };
  }
  if (!user) return { allowed: true, reason: null, remainingWatchSeconds: null };
  const remaining = await remainingWatchSeconds(user);
  if (remaining !== null && remaining <= 0) return { allowed: false, reason: 'DAILY_LIMIT', remainingWatchSeconds: 0 };
  return { allowed: true, reason: null, remainingWatchSeconds: remaining };
}

/** Resolve a Video.*Path inside MEDIA_DIR, refusing anything that escapes it. */
function mediaFile(rel: string | null): string | null {
  if (!rel) return null;
  const abs = path.resolve(MEDIA_DIR, rel);
  if (!abs.startsWith(MEDIA_DIR + path.sep)) return null;
  return existsSync(abs) ? abs : null;
}

function serializeVideo(v: Video) {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    channelName: v.channelName,
    durationSec: v.durationSec,
    fileSizeBytes: v.fileSizeBytes,
    isPremium: v.isPremium,
    isExclusive: v.isExclusive,
    earlyAccessUntil: v.earlyAccessUntil && v.earlyAccessUntil > new Date() ? v.earlyAccessUntil : null,
    isDownloadable: v.isDownloadable,
    views: v.views,
    createdAt: v.createdAt,
    thumbnailUrl: `/api/videos/${v.id}/thumbnail`,
    captionsUrl: v.captionsPath ? `/api/videos/${v.id}/captions` : null,
    streamUrl: `/api/videos/${v.id}/stream`,
  };
}

async function loadVideo(id: string) {
  const video = await prisma.video.findUnique({ where: { id } });
  if (!video) throw new HttpError(404, 'Video not found', 'NOT_FOUND');
  return video;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = z.string().trim().max(100).optional().parse(req.query.q || undefined);
    const videos = await prisma.video.findMany({
      where: q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
              { channelName: { contains: q, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
    });
    const progress = req.user
      ? await prisma.watchProgress.findMany({ where: { userId: req.user.id, videoId: { in: videos.map((v) => v.id) } } })
      : [];
    const byVideo = new Map(progress.map((p) => [p.videoId, p]));
    res.json({
      items: videos.map((v) => {
        const p = byVideo.get(v.id);
        return { ...serializeVideo(v), progress: p ? { positionSec: p.positionSec, durationSec: p.durationSec, completed: p.completed } : null };
      }),
    });
  }),
);

router.get(
  '/continue-watching',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await prisma.watchProgress.findMany({
      where: { userId: req.user!.id, completed: false, positionSec: { gt: 5 } },
      orderBy: { updatedAt: 'desc' },
      take: 12,
      include: { video: true },
    });
    res.json({
      items: rows.map((r) => ({
        ...serializeVideo(r.video),
        progress: { positionSec: r.positionSec, durationSec: r.durationSec, completed: r.completed },
      })),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const video = await loadVideo(req.params.id);
    const [access, progress, nextVideo] = await Promise.all([
      computeAccess(req.user, video),
      req.user
        ? prisma.watchProgress.findUnique({ where: { userId_videoId: { userId: req.user.id, videoId: video.id } } })
        : null,
      // "Next" = the next-older video, wrapping to the newest.
      prisma.video
        .findFirst({ where: { createdAt: { lt: video.createdAt }, id: { not: video.id } }, orderBy: { createdAt: 'desc' } })
        .then((v) => v ?? prisma.video.findFirst({ where: { id: { not: video.id } }, orderBy: { createdAt: 'desc' } })),
      prisma.video.update({ where: { id: video.id }, data: { views: { increment: 1 } } }),
    ]);
    const features = planFeatures(req.user ?? { plan: 'FREE', planExpiresAt: null });
    res.json({
      video: serializeVideo({ ...video, views: video.views + 1 }),
      progress: progress ? { positionSec: progress.positionSec, durationSec: progress.durationSec, completed: progress.completed } : null,
      access,
      nextVideo: nextVideo ? serializeVideo(nextVideo) : null,
      features: {
        plan: features.tier,
        adFree: features.adFree,
        maxQuality: features.maxQuality,
        dailyWatchMinutes: features.dailyWatchMinutes,
        fasterStreaming: features.fasterStreaming,
      },
      completePercent: COMPLETE_PERCENT,
    });
  }),
);

/**
 * Delivery rate for plans without fasterStreaming: 1.5× the video's own average bitrate (never below
 * 256 KB/s). Playback always keeps up; buffering ahead and seeking are just slower than on priority.
 */
function standardStreamRate(video: Video, fileSize: number) {
  const avgBytesPerSec = video.durationSec > 0 ? fileSize / video.durationSec : 0;
  return Math.max(256 * 1024, Math.ceil(avgBytesPerSec * 1.5));
}

/** Paces a stream to `bytesPerSec` (token bucket, 100 ms ticks). */
function throttle(bytesPerSec: number) {
  const started = Date.now();
  let sent = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      sent += chunk.length;
      const due = started + (sent / bytesPerSec) * 1000;
      const wait = due - Date.now();
      if (wait > 0) setTimeout(() => done(null, chunk), wait);
      else done(null, chunk);
    },
  });
}

function sendRange(req: Request, res: Response, file: string, contentType: string, bytesPerSec: number | null = null) {
  const pipe = (stream: NodeJS.ReadableStream) => {
    req.on('close', () => (stream as unknown as { destroy(): void }).destroy());
    (bytesPerSec ? stream.pipe(throttle(bytesPerSec)) : stream).pipe(res);
  };
  const { size } = statSync(file);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    return pipe(createReadStream(file));
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = m && m[1] ? Number(m[1]) : NaN;
  let end = m && m[2] ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    // Suffix range: last N bytes.
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (Number.isNaN(end) || end >= size) end = size - 1;
  if (!m || Number.isNaN(start) || start > end || start >= size) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  pipe(createReadStream(file, { start, end }));
}

router.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const video = await loadVideo(req.params.id);
    const access = await computeAccess(req.user, video);
    if (!access.allowed) {
      const status = access.reason === 'SIGN_IN' ? 401 : 403;
      throw new HttpError(status, 'You do not have access to this video', access.reason ?? 'FORBIDDEN');
    }
    if (/^https?:\/\//.test(video.videoPath)) return res.redirect(video.videoPath);
    const file = mediaFile(video.videoPath);
    if (!file) throw new HttpError(404, 'Video file missing', 'NOT_FOUND');
    // Faster streaming (Silver/Gold) is unthrottled; everyone else gets the standard delivery rate.
    const fast = !!req.user && planFeatures(req.user).fasterStreaming;
    res.setHeader('X-Stream-Tier', fast ? 'priority' : 'standard');
    sendRange(req, res, file, 'video/mp4', fast ? null : standardStreamRate(video, statSync(file).size));
  }),
);

router.get(
  '/:id/thumbnail',
  asyncHandler(async (req, res) => {
    const video = await loadVideo(req.params.id);
    const file = mediaFile(video.thumbnailPath);
    if (!file) throw new HttpError(404, 'No thumbnail', 'NOT_FOUND');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  }),
);

router.get(
  '/:id/captions',
  asyncHandler(async (req, res) => {
    const video = await loadVideo(req.params.id);
    const file = mediaFile(video.captionsPath);
    if (!file) throw new HttpError(404, 'No captions', 'NOT_FOUND');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(file, { headers: { 'Content-Type': 'text/vtt; charset=utf-8' } });
  }),
);

router.put(
  '/:id/progress',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        positionSec: z.number().min(0).max(24 * 3600),
        durationSec: z.number().min(0).max(24 * 3600),
        watchedDeltaSec: z.number().min(0).max(3600).default(0),
      })
      .parse(req.body);
    const video = await loadVideo(req.params.id);
    const userId = req.user!.id;
    const duration = body.durationSec || video.durationSec;
    const position = duration ? Math.min(body.positionSec, duration) : body.positionSec;
    const reachedEnd = duration > 0 && (position / duration) * 100 >= COMPLETE_PERCENT;

    const existing = await prisma.watchProgress.findUnique({ where: { userId_videoId: { userId, videoId: video.id } } });
    // Once completed, stay completed (rewatching shouldn't un-complete it).
    const completed = reachedEnd || !!existing?.completed;
    const progress = await prisma.watchProgress.upsert({
      where: { userId_videoId: { userId, videoId: video.id } },
      create: { userId, videoId: video.id, positionSec: position, durationSec: duration, completed },
      update: { positionSec: position, durationSec: duration, completed },
    });

    const delta = Math.round(Math.min(body.watchedDeltaSec, MAX_DELTA_PER_CALL));
    if (delta > 0) {
      const date = istDateKey();
      await prisma.dailyUsage.upsert({
        where: { userId_date: { userId, date } },
        create: { userId, date, watchSeconds: delta },
        update: { watchSeconds: { increment: delta } },
      });
    }
    const remaining = await remainingWatchSeconds(req.user!);
    res.json({
      progress: { positionSec: progress.positionSec, durationSec: progress.durationSec, completed: progress.completed },
      justCompleted: completed && !existing?.completed,
      remainingWatchSeconds: remaining,
      limitReached: remaining !== null && remaining <= 0,
    });
  }),
);
