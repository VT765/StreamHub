import { Prisma, type Comment, type User } from '@prisma/client';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { getClientIp } from '../../lib/clientInfo.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { prisma, transactionWithRetry } from '../../lib/prisma.js';
import { optionalAuth, requireAdmin, requireAuth } from '../../middleware/auth.js';
import { createCaptcha, markSolved, recentlySolved, verifyCaptcha } from './captcha.js';
import {
  BLOCK_MESSAGES,
  checkContent,
  contentHash,
  detectLanguage,
  extractMentions,
  type BlockReason,
} from './moderation.js';
import { SUPPORTED_LANGS, translateText } from './translate.js';

export const router = Router();

// ───────── Thresholds ─────────
const LIMITS = {
  perMinute: 8,
  perHour: 30,
  /** CAPTCHA kicks in after this many blocked attempts in 10 minutes… */
  blockedBeforeCaptcha: 3,
  /** …or this many posts within 2 minutes. */
  burstBeforeCaptcha: 4,
  duplicateWindowMs: 10 * 60_000,
  pageSize: 20,
  maxLength: 2000,
};

const LIVE: Prisma.CommentWhereInput = { status: { in: ['VISIBLE', 'FLAGGED'] } };

const commentInclude = {
  user: { select: { id: true, username: true, name: true, avatarUrl: true } },
  mentions: { select: { user: { select: { username: true } } } },
  _count: { select: { replies: { where: LIVE } } },
} satisfies Prisma.CommentInclude;

type CommentRow = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;

const editWindowMs = () => config.comments.editWindowMinutes * 60_000;
const withinWindow = (c: Comment) => Date.now() - c.createdAt.getTime() < editWindowMs();

function serialize(c: CommentRow, viewer: User | undefined, myReaction: 'LIKE' | 'DISLIKE' | null) {
  const isAdmin = viewer?.role === 'ADMIN';
  const isAuthor = viewer?.id === c.userId;
  const deleted = c.status === 'DELETED';
  const hidden = c.status === 'HIDDEN';
  const showContent = !deleted && (!hidden || isAdmin);
  const live = !deleted && !hidden;
  return {
    id: c.id,
    videoId: c.videoId,
    parentId: c.parentId,
    content: showContent ? c.content : null,
    placeholder: deleted ? 'This comment was deleted' : hidden && !isAdmin ? 'This comment was removed by a moderator' : null,
    status: isAdmin || isAuthor ? c.status : c.status === 'FLAGGED' ? 'VISIBLE' : c.status,
    language: c.language,
    author: deleted ? null : c.user,
    location: deleted ? null : { city: c.city, country: c.country },
    createdAt: c.createdAt,
    editedAt: c.editedAt,
    edited: !!c.editedAt,
    likeCount: c.likeCount,
    dislikeCount: c.dislikeCount,
    replyCount: c._count.replies,
    myReaction,
    version: c.version,
    mentions: c.mentions.map((m) => m.user.username),
    isAuthor,
    canEdit: live && isAuthor && withinWindow(c),
    canDelete: !deleted && ((isAuthor && withinWindow(c)) || isAdmin),
    editableUntil: isAuthor ? new Date(c.createdAt.getTime() + editWindowMs()) : null,
  };
}

async function serializeMany(rows: CommentRow[], viewer: User | undefined) {
  const reactions = viewer
    ? await prisma.commentReaction.findMany({
        where: { userId: viewer.id, commentId: { in: rows.map((r) => r.id) } },
      })
    : [];
  const byId = new Map(reactions.map((r) => [r.commentId, r.type]));
  return rows.map((r) => serialize(r, viewer, byId.get(r.id) ?? null));
}

async function loadOne(id: string, viewer: User | undefined) {
  const row = await prisma.comment.findUnique({ where: { id }, include: commentInclude });
  if (!row) throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
  return (await serializeMany([row], viewer))[0];
}

/** Hot-ish ranking: engagement with gentle time decay. */
function relevance(c: CommentRow) {
  const ageHours = (Date.now() - c.createdAt.getTime()) / 3_600_000;
  const engagement = c.likeCount * 2 + c._count.replies * 3 - c.dislikeCount;
  return (engagement + 1) / Math.pow(ageHours + 2, 0.8);
}

// ───────── Reading ─────────

router.get(
  '/video/:videoId',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { sort, cursor } = z
      .object({
        sort: z.enum(['newest', 'oldest', 'most_liked', 'relevant']).default('relevant'),
        cursor: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const isAdmin = req.user?.role === 'ADMIN';

    // Deleted/hidden parents stay as placeholders only while they have live replies.
    const where: Prisma.CommentWhereInput = {
      videoId: req.params.videoId,
      parentId: null,
      OR: [LIVE, ...(isAdmin ? [{ status: 'HIDDEN' as const }] : []), { replies: { some: LIVE } }],
    };

    let rows: CommentRow[];
    if (sort === 'relevant') {
      const all = await prisma.comment.findMany({ where, include: commentInclude, orderBy: { createdAt: 'desc' }, take: 1000 });
      rows = all.sort((a, b) => relevance(b) - relevance(a)).slice(cursor, cursor + LIMITS.pageSize + 1);
    } else {
      const orderBy: Prisma.CommentOrderByWithRelationInput[] =
        sort === 'newest'
          ? [{ createdAt: 'desc' }]
          : sort === 'oldest'
            ? [{ createdAt: 'asc' }]
            : [{ likeCount: 'desc' }, { createdAt: 'desc' }];
      rows = await prisma.comment.findMany({ where, include: commentInclude, orderBy, skip: cursor, take: LIMITS.pageSize + 1 });
    }

    const hasMore = rows.length > LIMITS.pageSize;
    const page = rows.slice(0, LIMITS.pageSize);
    const total = await prisma.comment.count({ where: { videoId: req.params.videoId, ...LIVE } });
    res.json({
      items: await serializeMany(page, req.user),
      nextCursor: hasMore ? cursor + LIMITS.pageSize : null,
      total,
      editWindowMinutes: config.comments.editWindowMinutes,
    });
  }),
);

router.get(
  '/:id/replies',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const isAdmin = req.user?.role === 'ADMIN';
    const rows = await prisma.comment.findMany({
      where: { parentId: req.params.id, status: { in: isAdmin ? ['VISIBLE', 'FLAGGED', 'HIDDEN'] : ['VISIBLE', 'FLAGGED'] } },
      include: commentInclude,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    res.json({ items: await serializeMany(rows, req.user) });
  }),
);

// ───────── Posting ─────────

router.get(
  '/captcha',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(createCaptcha(req.user!.id));
  }),
);

async function recordAttempt(userId: string, content: string, ip: string | null, blockReason: BlockReason | null) {
  await prisma.commentAttempt.create({
    data: { userId, accepted: !blockReason, blockReason, content: content.slice(0, LIMITS.maxLength), ip },
  });
}

function blocked(reason: BlockReason, status = 422): never {
  throw new HttpError(status, BLOCK_MESSAGES[reason], reason === 'CAPTCHA' ? 'CAPTCHA_REQUIRED' : 'COMMENT_BLOCKED', { reason });
}

async function resolveMentions(content: string) {
  const names = extractMentions(content);
  if (!names.length) return [];
  const users = await prisma.user.findMany({
    where: { OR: names.map((n) => ({ username: { equals: n, mode: 'insensitive' as const } })) },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

const contentSchema = z
  .string()
  .trim()
  .min(1, 'Comment can’t be empty')
  .max(LIMITS.maxLength, `Comments are limited to ${LIMITS.maxLength} characters`);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        videoId: z.string().min(1),
        parentId: z.string().optional().nullable(),
        content: contentSchema,
        captchaToken: z.string().optional(),
        captchaAnswer: z.string().optional(),
      })
      .parse(req.body);
    const user = req.user!;
    const ip = getClientIp(req);

    const video = await prisma.video.findUnique({ where: { id: body.videoId }, select: { id: true } });
    if (!video) throw new HttpError(404, 'Video not found', 'NOT_FOUND');

    let parentId: string | null = null;
    if (body.parentId) {
      const parent = await prisma.comment.findUnique({ where: { id: body.parentId } });
      if (!parent || parent.videoId !== body.videoId) throw new HttpError(404, 'The comment you’re replying to no longer exists', 'PARENT_NOT_FOUND');
      if (parent.status === 'DELETED' || parent.status === 'HIDDEN') {
        throw new HttpError(400, 'You can’t reply to a deleted comment', 'PARENT_DELETED');
      }
      // One nesting level: replies to replies attach to the top-level thread.
      parentId = parent.parentId ?? parent.id;
    }

    // Flood control.
    const now = Date.now();
    const [perMinute, perHour, burst, recentBlocked] = await Promise.all([
      prisma.commentAttempt.count({ where: { userId: user.id, accepted: true, createdAt: { gte: new Date(now - 60_000) } } }),
      prisma.commentAttempt.count({ where: { userId: user.id, accepted: true, createdAt: { gte: new Date(now - 3_600_000) } } }),
      prisma.commentAttempt.count({
        // NULL-safe: accepted attempts have no blockReason and must count toward the burst.
        where: { userId: user.id, createdAt: { gte: new Date(now - 120_000) }, OR: [{ blockReason: null }, { blockReason: { not: 'CAPTCHA' } }] },
      }),
      prisma.commentAttempt.count({
        where: { userId: user.id, accepted: false, blockReason: { not: 'CAPTCHA' }, createdAt: { gte: new Date(now - 600_000) } },
      }),
    ]);
    if (perMinute >= LIMITS.perMinute || perHour >= LIMITS.perHour) {
      await recordAttempt(user.id, body.content, ip, 'RATE_LIMIT');
      blocked('RATE_LIMIT', 429);
    }

    const captchaNeeded =
      (recentBlocked >= LIMITS.blockedBeforeCaptcha || burst >= LIMITS.burstBeforeCaptcha) && !recentlySolved(user.id);
    if (captchaNeeded) {
      if (!body.captchaToken) {
        await recordAttempt(user.id, body.content, ip, 'CAPTCHA');
        blocked('CAPTCHA', 428);
      }
      if (!verifyCaptcha(user.id, body.captchaToken, body.captchaAnswer)) {
        await recordAttempt(user.id, body.content, ip, 'CAPTCHA');
        throw new HttpError(428, 'That CAPTCHA answer wasn’t right. Please try again.', 'CAPTCHA_REQUIRED', {
          reason: 'CAPTCHA',
          invalid: true,
        });
      }
      markSolved(user.id);
    }

    const reason = checkContent(body.content);
    if (reason) {
      await recordAttempt(user.id, body.content, ip, reason);
      blocked(reason);
    }

    const hash = contentHash(body.content);
    const duplicate = await prisma.comment.findFirst({
      where: {
        userId: user.id,
        contentHash: hash,
        status: { not: 'DELETED' },
        OR: [{ videoId: body.videoId }, { createdAt: { gte: new Date(now - LIMITS.duplicateWindowMs) } }],
      },
      select: { id: true },
    });
    if (duplicate) {
      await recordAttempt(user.id, body.content, ip, 'DUPLICATE');
      blocked('DUPLICATE', 409);
    }

    const mentionIds = await resolveMentions(body.content);
    const created = await prisma.comment.create({
      data: {
        videoId: body.videoId,
        userId: user.id,
        parentId,
        content: body.content,
        contentHash: hash,
        language: detectLanguage(body.content),
        city: user.city,
        country: user.country,
        mentions: { create: mentionIds.map((userId) => ({ userId })) },
      },
    });
    await recordAttempt(user.id, body.content, ip, null);
    res.status(201).json({ comment: await loadOne(created.id, user) });
  }),
);

// ───────── Editing & deleting ─────────

router.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { content, version } = z.object({ content: contentSchema, version: z.number().int() }).parse(req.body);
    const user = req.user!;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment || comment.status === 'DELETED') throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
    if (comment.userId !== user.id) throw new HttpError(403, 'You can only edit your own comments', 'FORBIDDEN');
    if (comment.status === 'HIDDEN') throw new HttpError(403, 'This comment was removed by a moderator', 'FORBIDDEN');
    if (!withinWindow(comment)) {
      throw new HttpError(403, `Comments can only be edited within ${config.comments.editWindowMinutes} minutes of posting`, 'EDIT_WINDOW_CLOSED');
    }
    if (comment.version !== version) {
      throw new HttpError(409, 'This comment was changed somewhere else. Here’s the latest version.', 'EDIT_CONFLICT', {
        comment: await loadOne(comment.id, user),
      });
    }
    if (content === comment.content) return res.json({ comment: await loadOne(comment.id, user) });

    const reason = checkContent(content);
    if (reason) {
      await recordAttempt(user.id, content, getClientIp(req), reason);
      blocked(reason);
    }

    const mentionIds = await resolveMentions(content);
    await transactionWithRetry(async (tx) => {
      // Compare-and-swap on version so two simultaneous edits can't both win.
      const { count } = await tx.comment.updateMany({
        where: { id: comment.id, version },
        data: {
          content,
          contentHash: contentHash(content),
          language: detectLanguage(content),
          version: { increment: 1 },
          editedAt: new Date(),
        },
      });
      if (count === 0) throw new HttpError(409, 'This comment was changed somewhere else.', 'EDIT_CONFLICT');
      await tx.commentEdit.create({ data: { commentId: comment.id, previousContent: comment.content, version } });
      await tx.commentMention.deleteMany({ where: { commentId: comment.id } });
      if (mentionIds.length) await tx.commentMention.createMany({ data: mentionIds.map((userId) => ({ commentId: comment.id, userId })) });
      await tx.commentTranslation.deleteMany({ where: { commentId: comment.id } });
    }).catch(async (err) => {
      if (err instanceof HttpError && err.code === 'EDIT_CONFLICT') {
        err.details = { comment: await loadOne(comment.id, user) };
      }
      throw err;
    });
    res.json({ comment: await loadOne(comment.id, user) });
  }),
);

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment || comment.status === 'DELETED') throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
    const isAdmin = user.role === 'ADMIN';
    if (comment.userId !== user.id && !isAdmin) throw new HttpError(403, 'You can only delete your own comments', 'FORBIDDEN');
    if (!isAdmin && !withinWindow(comment)) {
      throw new HttpError(403, `Comments can only be deleted within ${config.comments.editWindowMinutes} minutes of posting`, 'EDIT_WINDOW_CLOSED');
    }
    // Always a soft delete: the row stays for history/audit; replies keep their thread
    // and the parent renders as a "deleted" placeholder while it has live replies.
    await prisma.comment.update({ where: { id: comment.id }, data: { status: 'DELETED', deletedAt: new Date() } });
    if (isAdmin && comment.userId !== user.id) {
      await prisma.moderationAction.create({ data: { commentId: comment.id, moderatorId: user.id, action: 'DELETE' } });
    }
    const liveReplies = await prisma.comment.count({ where: { parentId: comment.id, ...LIVE } });
    res.json({ ok: true, keptAsPlaceholder: liveReplies > 0 });
  }),
);

router.get(
  '/:id/history',
  requireAuth,
  asyncHandler(async (req, res) => {
    const comment = await prisma.comment.findUnique({
      where: { id: req.params.id },
      include: { edits: { orderBy: { editedAt: 'asc' } } },
    });
    if (!comment) throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
    if (comment.userId !== req.user!.id && req.user!.role !== 'ADMIN') throw new HttpError(403, 'Not allowed', 'FORBIDDEN');
    res.json({
      current: { content: comment.content, version: comment.version, editedAt: comment.editedAt },
      edits: comment.edits,
    });
  }),
);

// ───────── Reactions ─────────

router.post(
  '/:id/reaction',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { type } = z.object({ type: z.enum(['LIKE', 'DISLIKE']).nullable() }).parse(req.body);
    const userId = req.user!.id;
    const commentId = req.params.id;

    const run = () =>
      transactionWithRetry(async (tx) => {
        const comment = await tx.comment.findUnique({ where: { id: commentId }, select: { status: true } });
        if (!comment || comment.status === 'DELETED' || comment.status === 'HIDDEN') {
          throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
        }
        const existing = await tx.commentReaction.findUnique({ where: { userId_commentId: { userId, commentId } } });
        const prev = existing?.type ?? null;
        if (prev === type) return;

        if (type === null) await tx.commentReaction.delete({ where: { userId_commentId: { userId, commentId } } });
        else if (prev) await tx.commentReaction.update({ where: { userId_commentId: { userId, commentId } }, data: { type } });
        else await tx.commentReaction.create({ data: { userId, commentId, type } });

        // Dislikes are only counted — they never hide or delete a comment.
        await tx.comment.update({
          where: { id: commentId },
          data: {
            likeCount: { increment: (type === 'LIKE' ? 1 : 0) - (prev === 'LIKE' ? 1 : 0) },
            dislikeCount: { increment: (type === 'DISLIKE' ? 1 : 0) - (prev === 'DISLIKE' ? 1 : 0) },
          },
        });
      });

    try {
      await run();
    } catch (err) {
      // Double-click race on the unique (user, comment) key — retry once against the fresh state.
      if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2002' || err.code === 'P2025')) await run();
      else throw err;
    }
    const c = await prisma.comment.findUnique({ where: { id: commentId }, select: { likeCount: true, dislikeCount: true } });
    res.json({ likeCount: c!.likeCount, dislikeCount: c!.dislikeCount, myReaction: type });
  }),
);

// ───────── Translation ─────────

const translateLimiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false });

router.post(
  '/:id/translate',
  translateLimiter,
  asyncHandler(async (req, res) => {
    const { targetLang } = z.object({ targetLang: z.string().min(2).max(5) }).parse(req.body);
    const target = targetLang.toLowerCase().split('-')[0];
    if (!SUPPORTED_LANGS.includes(target)) throw new HttpError(400, 'That language isn’t supported yet', 'UNSUPPORTED_LANGUAGE');

    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment || comment.status === 'DELETED' || comment.status === 'HIDDEN') throw new HttpError(404, 'Comment not found', 'NOT_FOUND');

    if (comment.language === target) {
      return res.json({ text: comment.content, sourceLang: comment.language, targetLang: target, sameLanguage: true });
    }
    const cached = await prisma.commentTranslation.findUnique({
      where: { commentId_targetLang: { commentId: comment.id, targetLang: target } },
    });
    if (cached) return res.json({ text: cached.text, sourceLang: cached.sourceLang, targetLang: target, cached: true });

    const out = await translateText(comment.content, comment.language, target);
    await prisma.commentTranslation
      .upsert({
        where: { commentId_targetLang: { commentId: comment.id, targetLang: target } },
        create: { commentId: comment.id, targetLang: target, text: out.text, sourceLang: out.sourceLang },
        update: { text: out.text, sourceLang: out.sourceLang },
      })
      .catch(() => {});
    res.json({ text: out.text, sourceLang: out.sourceLang, targetLang: target });
  }),
);

// ───────── Reporting ─────────

router.post(
  '/:id/report',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { reason, details } = z
      .object({
        reason: z.enum(['SPAM', 'HARASSMENT', 'OFFENSIVE', 'HATE_SPEECH', 'MISINFORMATION', 'OTHER']),
        details: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment || comment.status === 'DELETED') throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
    if (comment.userId === req.user!.id) throw new HttpError(400, 'You can’t report your own comment', 'OWN_COMMENT');

    try {
      await prisma.commentReport.create({ data: { commentId: comment.id, reporterId: req.user!.id, reason, details } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'You’ve already reported this comment. Our moderators will review it.', 'ALREADY_REPORTED');
      }
      throw err;
    }
    // Flag for review — the comment stays visible until an admin decides.
    if (comment.status === 'VISIBLE') await prisma.comment.update({ where: { id: comment.id }, data: { status: 'FLAGGED' } });
    res.status(201).json({ ok: true });
  }),
);

// ───────── Admin moderation ─────────

router.get(
  '/admin/reports',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') }).parse(req.query);
    const reportFilter: Prisma.CommentReportWhereInput =
      status === 'OPEN' ? { status: 'OPEN' } : { status: { in: ['RESOLVED_REMOVED', 'RESOLVED_KEPT'] } };
    const comments = await prisma.comment.findMany({
      where: { reports: { some: reportFilter } },
      include: {
        user: { select: { id: true, username: true, name: true, avatarUrl: true } },
        video: { select: { id: true, title: true } },
        reports: {
          where: reportFilter,
          include: { reporter: { select: { username: true } } },
          orderBy: { createdAt: 'desc' },
        },
        moderation: { include: { moderator: { select: { username: true } } }, orderBy: { createdAt: 'desc' }, take: 5 },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const items = comments
      .map((c) => {
        const reasonCounts: Record<string, number> = {};
        for (const r of c.reports) reasonCounts[r.reason] = (reasonCounts[r.reason] ?? 0) + 1;
        return {
          comment: {
            id: c.id,
            content: c.content,
            status: c.status,
            language: c.language,
            createdAt: c.createdAt,
            likeCount: c.likeCount,
            dislikeCount: c.dislikeCount,
          },
          author: c.user,
          video: c.video,
          reportCount: c.reports.length,
          reasonCounts,
          latestReportAt: c.reports[0]?.createdAt ?? null,
          reports: c.reports.map((r) => ({
            id: r.id,
            reason: r.reason,
            details: r.details,
            reporter: r.reporter.username,
            createdAt: r.createdAt,
            status: r.status,
          })),
          moderation: c.moderation.map((m) => ({ action: m.action, note: m.note, moderator: m.moderator.username, createdAt: m.createdAt })),
        };
      })
      .sort((a, b) => b.reportCount - a.reportCount);
    res.json({ items });
  }),
);

router.post(
  '/admin/comments/:id/action',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { action, note } = z
      .object({ action: z.enum(['HIDE', 'RESTORE', 'DISMISS_REPORTS']), note: z.string().trim().max(500).optional() })
      .parse(req.body);
    const comment = await prisma.comment.findUnique({ where: { id: req.params.id } });
    if (!comment) throw new HttpError(404, 'Comment not found', 'NOT_FOUND');
    if (comment.status === 'DELETED' && action !== 'DISMISS_REPORTS') {
      throw new HttpError(400, 'The author already deleted this comment', 'ALREADY_DELETED');
    }

    // Dismissing reports on an author-deleted comment just closes them.
    const status = comment.status === 'DELETED' ? 'DELETED' : action === 'HIDE' ? 'HIDDEN' : 'VISIBLE';
    const reportStatus = action === 'HIDE' ? 'RESOLVED_REMOVED' : 'RESOLVED_KEPT';
    await prisma.$transaction([
      prisma.comment.update({ where: { id: comment.id }, data: { status } }),
      prisma.commentReport.updateMany({
        where: { commentId: comment.id, status: 'OPEN' },
        data: { status: reportStatus, resolvedAt: new Date() },
      }),
      prisma.moderationAction.create({ data: { commentId: comment.id, moderatorId: req.user!.id, action, note } }),
    ]);
    res.json({ ok: true, status });
  }),
);

router.get(
  '/admin/attempts',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page, reason } = z
      .object({ page: z.coerce.number().int().min(1).default(1), reason: z.string().optional() })
      .parse(req.query);
    const where: Prisma.CommentAttemptWhereInput = { accepted: false, ...(reason ? { blockReason: reason } : {}) };
    const [items, total, byReason] = await Promise.all([
      prisma.commentAttempt.findMany({
        where,
        include: { user: { select: { username: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 30,
        take: 30,
      }),
      prisma.commentAttempt.count({ where }),
      prisma.commentAttempt.groupBy({ by: ['blockReason'], where: { accepted: false }, _count: true }),
    ]);
    res.json({
      items,
      total,
      page,
      pageSize: 30,
      byReason: Object.fromEntries(byReason.map((b) => [b.blockReason ?? 'UNKNOWN', b._count])),
    });
  }),
);
