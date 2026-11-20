import type { MeetingRole, User } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../lib/prisma.js';
import { authenticateToken, SESSION_COOKIE } from '../../middleware/auth.js';
import { findMeetingFile } from './routes.js';
import {
  canModerate,
  effectiveCanChat,
  effectiveCanScreenShare,
  liveRooms,
  normalizeRoomCode,
  publicParticipant,
  publicRoom,
  roomFromMeeting,
  type LiveParticipant,
  type LiveRoom,
} from './state.js';

/**
 * Signaling + room control for WebRTC full-mesh calls.
 *
 * Client → server: room:join, room:leave, signal, media:update, chat:send,
 *   mod:mute, mod:muteAll, mod:remove, mod:lock, mod:role, mod:permissions, mod:settings, mod:end
 * Server → client: participant:joined, participant:updated, participant:left, participants:sync,
 *   room:updated, room:replaced, room:removed, room:ended, signal, chat:message,
 *   force:mute, force:stopScreen, notice
 */

const RECONNECT_GRACE_MS = 30_000;

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; code: string; message: string }) => void;

interface SocketData {
  user: User;
  roomCode?: string;
}
type AppSocket = Socket & { data: SocketData };

function parseCookies(header: string | undefined) {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function fail(ack: Ack | undefined, code: string, message: string) {
  if (typeof ack === 'function') ack({ ok: false, code, message });
}

function ok(ack: Ack | undefined, data: Record<string, unknown> = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...data });
}

export function attachMeetingSockets(server: HttpServer) {
  const io = new IOServer(server, {
    path: '/socket.io',
    cors: { origin: config.clientUrl, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 10_000,
  });

  io.use(async (socket, next) => {
    try {
      // Same-origin dev setups send the session cookie; production sends a short-lived socket token.
      const socketToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const auth =
        typeof socketToken === 'string'
          ? await authenticateToken(socketToken, 'socket')
          : await authenticateToken(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);
      if (!auth) return next(new Error('UNAUTHENTICATED'));
      (socket.data as SocketData).user = auth.user;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  // ───────── helpers bound to io ─────────

  const emitRoom = (room: LiveRoom, event: string, payload: unknown) => io.to(room.roomCode).emit(event, payload);
  const emitTo = (p: LiveParticipant, event: string, payload: unknown = {}) => io.to(p.socketId).emit(event, payload);
  const broadcastParticipant = (room: LiveRoom, p: LiveParticipant) =>
    emitRoom(room, 'participant:updated', { participant: publicParticipant(room, p) });
  const syncAll = (room: LiveRoom) =>
    emitRoom(room, 'participants:sync', {
      room: publicRoom(room),
      participants: [...room.participants.values()].map((p) => publicParticipant(room, p)),
    });

  function detachSocket(socketId: string, roomCode: string) {
    const s = io.sockets.sockets.get(socketId) as AppSocket | undefined;
    if (!s) return;
    s.leave(roomCode);
    if (s.data.roomCode === roomCode) s.data.roomCode = undefined;
  }

  async function transferHost(room: LiveRoom, previousHostId: string) {
    const candidates = [...room.participants.values()].sort(
      (a, b) => (a.role === 'COHOST' ? 0 : 1) - (b.role === 'COHOST' ? 0 : 1) || a.joinedAt - b.joinedAt,
    );
    const next = candidates[0];
    if (!next) return;
    next.role = 'HOST';
    room.hostId = next.userId;
    await prisma.$transaction([
      prisma.meeting.update({ where: { id: room.meetingId }, data: { hostId: next.userId } }),
      prisma.meetingParticipant.updateMany({
        where: { meetingId: room.meetingId, userId: next.userId },
        data: { role: 'HOST' },
      }),
      prisma.meetingParticipant.updateMany({
        where: { meetingId: room.meetingId, userId: previousHostId },
        data: { role: 'PARTICIPANT' },
      }),
    ]);
    syncAll(room);
    emitRoom(room, 'notice', { message: `${next.name} is now the host` });
  }

  /** Remove a participant from live state now (explicit leave, grace expiry, removal). */
  async function finalizeLeave(room: LiveRoom, userId: string) {
    const p = room.participants.get(userId);
    if (!p) return;
    clearTimeout(p.leaveTimer);
    room.participants.delete(userId);
    detachSocket(p.socketId, room.roomCode);
    emitRoom(room, 'participant:left', { userId, socketId: p.socketId });
    await prisma.meetingParticipant
      .updateMany({ where: { meetingId: room.meetingId, userId }, data: { leftAt: new Date() } })
      .catch(console.error);

    if (room.participants.size === 0) {
      liveRooms.delete(room.roomCode);
      return;
    }
    if (room.hostId === userId) await transferHost(room, userId);
  }

  // ───────── connection ─────────

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as unknown as AppSocket;
    const user = socket.data.user;
    const chatTimes: number[] = [];

    /** Room + caller for an in-room event, or null. */
    function context() {
      const code = socket.data.roomCode;
      const room = code ? liveRooms.get(code) : undefined;
      const me = room?.participants.get(user.id);
      if (!room || !me || me.socketId !== socket.id) return null;
      return { room, me };
    }

    function moderatorContext(ack: Ack | undefined) {
      const ctx = context();
      if (!ctx) return fail(ack, 'NOT_IN_ROOM', 'You are not in this meeting'), null;
      if (!canModerate(ctx.me.role)) return fail(ack, 'FORBIDDEN', 'Only the host or co-hosts can do that'), null;
      return ctx;
    }

    function targetOf(room: LiveRoom, me: LiveParticipant, userId: unknown, ack: Ack | undefined) {
      const target = typeof userId === 'string' ? room.participants.get(userId) : undefined;
      if (!target) return fail(ack, 'NOT_FOUND', 'Participant not found'), null;
      // Co-hosts can't act on the host or other co-hosts.
      if (me.role === 'COHOST' && target.role !== 'PARTICIPANT' && target.userId !== me.userId) {
        return fail(ack, 'FORBIDDEN', 'Co-hosts can only manage participants'), null;
      }
      return target;
    }

    // ── join ──
    const joinSchema = z.object({
      roomCode: z.string().min(3).max(200),
      passcode: z.string().max(64).optional(),
      mic: z.boolean().default(false),
      cam: z.boolean().default(false),
    });

    socket.on('room:join', async (payload: unknown, ack?: Ack) => {
      try {
        const parsed = joinSchema.safeParse(payload);
        if (!parsed.success) return fail(ack, 'BAD_REQUEST', 'Invalid join request');
        const { passcode, mic, cam } = parsed.data;
        const code = normalizeRoomCode(parsed.data.roomCode);

        // A socket is in at most one room.
        const current = context();
        if (current && current.room.roomCode !== code) await finalizeLeave(current.room, user.id);

        const meeting = await prisma.meeting.findUnique({ where: { roomCode: code } });
        if (!meeting) return fail(ack, 'NOT_FOUND', 'This meeting doesn’t exist. Check the link or code.');
        if (meeting.endedAt) return fail(ack, 'ENDED', 'This meeting has ended.');
        const seat = await prisma.meetingParticipant.findUnique({
          where: { meetingId_userId: { meetingId: meeting.id, userId: user.id } },
        });
        if (seat?.removed) return fail(ack, 'REMOVED', 'You were removed from this meeting by the host.');

        const hostId = liveRooms.get(code)?.hostId ?? meeting.hostId;
        const isHost = hostId === user.id;
        const wasLive = liveRooms.get(code)?.participants.has(user.id) ?? false;

        if (!wasLive && !isHost && meeting.passcodeHash && !(seat && !seat.removed)) {
          if (!passcode) return fail(ack, 'PASSCODE_REQUIRED', 'This meeting needs a passcode.');
          if (!(await bcrypt.compare(passcode, meeting.passcodeHash))) {
            return fail(ack, 'WRONG_PASSCODE', 'That passcode isn’t right.');
          }
        }

        // ── No awaits from here until the participant is inserted (capacity/lock checks must be atomic). ──
        let room = liveRooms.get(code);
        if (!room) {
          room = roomFromMeeting(meeting);
          liveRooms.set(code, room);
        }
        const existing = room.participants.get(user.id);
        const liveRole: MeetingRole | undefined = existing?.role;
        const role: MeetingRole =
          room.hostId === user.id ? 'HOST' : liveRole ?? (seat?.role === 'COHOST' ? 'COHOST' : 'PARTICIPANT');

        if (!existing) {
          if (room.isLocked && !canModerate(role)) {
            if (room.participants.size === 0) liveRooms.delete(code);
            return fail(ack, 'LOCKED', 'The host has locked this meeting. No one new can join right now.');
          }
          if (room.participants.size >= room.maxParticipants) {
            return fail(ack, 'FULL', `This meeting is full (${room.maxParticipants} participants max).`);
          }
        }

        // Refresh / reconnect / second tab: the new socket replaces the old one.
        if (existing) {
          clearTimeout(existing.leaveTimer);
          if (existing.socketId !== socket.id) {
            io.to(existing.socketId).emit('room:replaced', {});
            detachSocket(existing.socketId, code);
          }
        }

        const participant: LiveParticipant = {
          userId: user.id,
          socketId: socket.id,
          name: user.name,
          username: user.username,
          avatarUrl: user.avatarUrl,
          role,
          mic,
          cam,
          screen: false,
          handRaised: existing?.handRaised ?? false,
          speaking: false,
          recording: false,
          quality: 'unknown',
          canScreenShare: existing?.canScreenShare ?? seat?.canScreenShare ?? null,
          canChat: existing?.canChat ?? seat?.canChat ?? null,
          joinedAt: existing?.joinedAt ?? Date.now(),
          connected: true,
        };
        room.participants.set(user.id, participant);
        socket.join(code);
        socket.data.roomCode = code;
        // ── end atomic section ──

        socket.to(code).emit('participant:joined', { participant: publicParticipant(room, participant) });

        await prisma.meetingParticipant.upsert({
          where: { meetingId_userId: { meetingId: meeting.id, userId: user.id } },
          create: { meetingId: meeting.id, userId: user.id, role },
          update: { role, leftAt: null, ...(existing ? {} : { joinedAt: new Date() }) },
        });
        if (!meeting.startedAt) {
          await prisma.meeting.update({ where: { id: meeting.id }, data: { startedAt: new Date(room.startedAt) } });
        }
        const messages = await prisma.meetingChatMessage.findMany({
          where: { meetingId: meeting.id },
          orderBy: { createdAt: 'desc' },
          take: 100,
          include: { user: { select: { name: true } } },
        });

        ok(ack, {
          selfId: socket.id,
          room: publicRoom(room),
          participants: [...room.participants.values()].map((p) => publicParticipant(room!, p)),
          messages: messages.reverse().map(serializeMessage),
          reconnected: !!existing,
        });
      } catch (err) {
        console.error('[meet] join failed', err);
        fail(ack, 'INTERNAL', 'Could not join the meeting. Please try again.');
      }
    });

    // ── signaling relay ──
    socket.on('signal', (payload: { to?: unknown; data?: unknown }) => {
      const ctx = context();
      if (!ctx || typeof payload?.to !== 'string') return;
      const target = [...ctx.room.participants.values()].find((p) => p.socketId === payload.to);
      if (!target || !target.connected) return;
      io.to(target.socketId).emit('signal', { from: socket.id, fromUserId: user.id, data: payload.data });
    });

    // ── media/presence state ──
    const mediaSchema = z
      .object({
        mic: z.boolean(),
        cam: z.boolean(),
        screen: z.boolean(),
        handRaised: z.boolean(),
        speaking: z.boolean(),
        recording: z.boolean(),
        quality: z.enum(['good', 'fair', 'poor', 'unknown']),
      })
      .partial();

    socket.on('media:update', (payload: unknown) => {
      const ctx = context();
      const parsed = mediaSchema.safeParse(payload);
      if (!ctx || !parsed.success) return;
      const { room, me } = ctx;
      const patch = parsed.data;
      if (patch.recording && me.role !== 'HOST') delete patch.recording;
      if (patch.screen && !effectiveCanScreenShare(room, me)) {
        delete patch.screen;
        socket.emit('force:stopScreen', { reason: 'Screen sharing is turned off for you by the host.' });
      }
      Object.assign(me, patch);
      // Speaking flips often and doesn't need to be reliable.
      if (Object.keys(patch).length === 1 && 'speaking' in patch) {
        io.to(room.roomCode).volatile.emit('participant:updated', { participant: publicParticipant(room, me) });
      } else {
        broadcastParticipant(room, me);
      }
    });

    // ── chat ──
    const chatSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('text'), content: z.string().trim().min(1).max(2000) }),
      z.object({ kind: z.literal('file'), fileId: z.string(), content: z.string().max(500).optional() }),
    ]);

    socket.on('chat:send', async (payload: unknown, ack?: Ack) => {
      try {
        const ctx = context();
        if (!ctx) return fail(ack, 'NOT_IN_ROOM', 'You are not in this meeting');
        const { room, me } = ctx;
        if (!effectiveCanChat(room, me)) return fail(ack, 'CHAT_DISABLED', 'The host has turned off chat for you.');

        const now = Date.now();
        while (chatTimes.length && now - chatTimes[0] > 10_000) chatTimes.shift();
        if (chatTimes.length >= 10) return fail(ack, 'RATE_LIMIT', 'Slow down — too many messages.');
        chatTimes.push(now);

        const parsed = chatSchema.safeParse(payload);
        if (!parsed.success) return fail(ack, 'BAD_REQUEST', 'Invalid message');
        const msg = parsed.data;

        let data: { kind: string; content: string; fileUrl?: string; fileName?: string; fileSize?: number };
        if (msg.kind === 'file') {
          const file = findMeetingFile(room.meetingId, msg.fileId);
          if (!file) return fail(ack, 'NOT_FOUND', 'File not found');
          data = {
            kind: 'file',
            content: msg.content ?? '',
            fileName: file.name,
            fileSize: file.size,
            fileUrl: `/api/meetings/${room.roomCode}/files/${msg.fileId}`,
          };
        } else {
          data = { kind: 'text', content: msg.content };
        }

        const saved = await prisma.meetingChatMessage.create({
          data: { meetingId: room.meetingId, userId: user.id, ...data },
          include: { user: { select: { name: true } } },
        });
        emitRoom(room, 'chat:message', { message: serializeMessage(saved) });
        ok(ack);
      } catch (err) {
        console.error('[meet] chat failed', err);
        fail(ack, 'INTERNAL', 'Message not sent');
      }
    });

    // ── moderation ──
    socket.on('mod:mute', (payload: { userId?: unknown }, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      const target = targetOf(ctx.room, ctx.me, payload?.userId, ack);
      if (!target) return;
      // We can only ask the client to mute; unmuting is always the participant's choice.
      emitTo(target, 'force:mute', { by: ctx.me.name });
      target.mic = false;
      broadcastParticipant(ctx.room, target);
      ok(ack);
    });

    socket.on('mod:muteAll', (_payload: unknown, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      for (const p of ctx.room.participants.values()) {
        if (p.userId === ctx.me.userId || p.role === 'HOST') continue;
        emitTo(p, 'force:mute', { by: ctx.me.name });
        p.mic = false;
      }
      syncAll(ctx.room);
      ok(ack);
    });

    socket.on('mod:remove', async (payload: { userId?: unknown }, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      const target = targetOf(ctx.room, ctx.me, payload?.userId, ack);
      if (!target) return;
      if (target.role === 'HOST' || target.userId === ctx.me.userId) return fail(ack, 'FORBIDDEN', 'You can’t remove this person');
      await prisma.meetingParticipant.updateMany({
        where: { meetingId: ctx.room.meetingId, userId: target.userId },
        data: { removed: true },
      });
      emitTo(target, 'room:removed', { by: ctx.me.name });
      await finalizeLeave(ctx.room, target.userId);
      emitRoom(ctx.room, 'notice', { message: `${target.name} was removed from the meeting` });
      ok(ack);
    });

    socket.on('mod:lock', async (payload: { locked?: unknown }, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      ctx.room.isLocked = payload?.locked === true;
      await prisma.meeting.update({ where: { id: ctx.room.meetingId }, data: { isLocked: ctx.room.isLocked } });
      emitRoom(ctx.room, 'room:updated', { room: publicRoom(ctx.room) });
      emitRoom(ctx.room, 'notice', { message: `${ctx.me.name} ${ctx.room.isLocked ? 'locked' : 'unlocked'} the meeting` });
      ok(ack);
    });

    socket.on('mod:role', async (payload: { userId?: unknown; role?: unknown }, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      if (ctx.me.role !== 'HOST') return fail(ack, 'FORBIDDEN', 'Only the host can change co-hosts');
      const target = targetOf(ctx.room, ctx.me, payload?.userId, ack);
      if (!target) return;
      if (target.role === 'HOST') return fail(ack, 'FORBIDDEN', 'The host’s role can’t be changed');
      const role: MeetingRole = payload?.role === 'COHOST' ? 'COHOST' : 'PARTICIPANT';
      target.role = role;
      await prisma.meetingParticipant.updateMany({
        where: { meetingId: ctx.room.meetingId, userId: target.userId },
        data: { role },
      });
      broadcastParticipant(ctx.room, target);
      emitTo(target, 'notice', { message: role === 'COHOST' ? 'You are now a co-host' : 'You are no longer a co-host' });
      ok(ack);
    });

    socket.on(
      'mod:permissions',
      async (payload: { userId?: unknown; canScreenShare?: unknown; canChat?: unknown }, ack?: Ack) => {
        const ctx = moderatorContext(ack);
        if (!ctx) return;
        const target = targetOf(ctx.room, ctx.me, payload?.userId, ack);
        if (!target) return;
        const asTri = (v: unknown) => (typeof v === 'boolean' ? v : v === null ? null : undefined);
        const canScreenShare = asTri(payload.canScreenShare);
        const canChat = asTri(payload.canChat);
        if (canScreenShare !== undefined) target.canScreenShare = canScreenShare;
        if (canChat !== undefined) target.canChat = canChat;
        await prisma.meetingParticipant.updateMany({
          where: { meetingId: ctx.room.meetingId, userId: target.userId },
          data: {
            ...(canScreenShare !== undefined ? { canScreenShare } : {}),
            ...(canChat !== undefined ? { canChat } : {}),
          },
        });
        if (target.screen && !effectiveCanScreenShare(ctx.room, target)) {
          emitTo(target, 'force:stopScreen', { reason: 'The host turned off screen sharing for you.' });
        }
        broadcastParticipant(ctx.room, target);
        ok(ack);
      },
    );

    socket.on('mod:settings', async (payload: { allowScreenShare?: unknown; allowChat?: unknown }, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      const { room } = ctx;
      if (typeof payload?.allowScreenShare === 'boolean') room.allowScreenShare = payload.allowScreenShare;
      if (typeof payload?.allowChat === 'boolean') room.allowChat = payload.allowChat;
      await prisma.meeting.update({
        where: { id: room.meetingId },
        data: { allowScreenShare: room.allowScreenShare, allowChat: room.allowChat },
      });
      for (const p of room.participants.values()) {
        if (p.screen && !effectiveCanScreenShare(room, p)) {
          emitTo(p, 'force:stopScreen', { reason: 'The host turned off screen sharing.' });
        }
      }
      syncAll(room);
      ok(ack);
    });

    socket.on('mod:end', async (_payload: unknown, ack?: Ack) => {
      const ctx = moderatorContext(ack);
      if (!ctx) return;
      if (ctx.me.role !== 'HOST') return fail(ack, 'FORBIDDEN', 'Only the host can end the meeting for everyone');
      const { room } = ctx;
      const now = new Date();
      await prisma.$transaction([
        prisma.meeting.update({ where: { id: room.meetingId }, data: { endedAt: now, isLocked: true } }),
        prisma.meetingParticipant.updateMany({ where: { meetingId: room.meetingId, leftAt: null }, data: { leftAt: now } }),
      ]);
      emitRoom(room, 'room:ended', { by: ctx.me.name });
      for (const p of room.participants.values()) {
        clearTimeout(p.leaveTimer);
        detachSocket(p.socketId, room.roomCode);
      }
      liveRooms.delete(room.roomCode);
      ok(ack);
    });

    // ── leaving ──
    socket.on('room:leave', async (_payload: unknown, ack?: Ack) => {
      const ctx = context();
      if (ctx) await finalizeLeave(ctx.room, user.id);
      ok(ack);
    });

    socket.on('disconnect', () => {
      const ctx = context();
      if (!ctx) return;
      const { room, me } = ctx;
      // Keep the seat for a grace period so refreshes and network blips don't drop the participant.
      me.connected = false;
      me.speaking = false;
      broadcastParticipant(room, me);
      me.leaveTimer = setTimeout(() => {
        const still = room.participants.get(me.userId);
        if (still && still.socketId === socket.id && !still.connected) void finalizeLeave(room, me.userId);
      }, RECONNECT_GRACE_MS);
    });
  });

  return io;
}

function serializeMessage(m: {
  id: string;
  userId: string;
  kind: string;
  content: string;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  createdAt: Date;
  user: { name: string };
}) {
  return {
    id: m.id,
    userId: m.userId,
    userName: m.user.name,
    kind: m.kind,
    content: m.content,
    fileUrl: m.fileUrl,
    fileName: m.fileName,
    fileSize: m.fileSize,
    createdAt: m.createdAt,
  };
}
