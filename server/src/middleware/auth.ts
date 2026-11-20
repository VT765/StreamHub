import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { prisma } from '../lib/prisma.js';

export const SESSION_COOKIE = 'sh_session';
const SESSION_TTL_DAYS = 30;

interface TokenPayload {
  sub: string;
  sid: string;
  /** 'socket' marks a short-lived call-signalling token; absent on session cookies. */
  typ?: 'socket';
}

/**
 * Short-lived token for the video-call socket. In production the browser opens the socket straight
 * to the API host (the frontend proxy can't carry WebSockets), where the session cookie isn't sent.
 */
export function signSocketToken(userId: string, sessionId: string) {
  return jwt.sign({ sub: userId, sid: sessionId, typ: 'socket' } satisfies TokenPayload, config.jwtSecret, { expiresIn: '2m' });
}

export function signSessionToken(userId: string, sessionId: string) {
  return jwt.sign({ sub: userId, sid: sessionId } satisfies TokenPayload, config.jwtSecret, {
    expiresIn: `${SESSION_TTL_DAYS}d`,
  });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !config.isDev,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Verify a raw token (session cookie, or a socket token when `kind` is 'socket') and load the live user + session. */
export async function authenticateToken(token: string | undefined, kind: 'session' | 'socket' = 'session') {
  if (!token) return null;
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as TokenPayload;
  } catch {
    return null;
  }
  // A socket token can't be used as a session cookie, and vice versa.
  if ((payload.typ === 'socket') !== (kind === 'socket')) return null;
  const session = await prisma.session.findUnique({ where: { id: payload.sid }, include: { user: true } });
  if (!session || session.revokedAt || session.userId !== payload.sub) return null;

  // Touch lastSeenAt at most once a minute.
  if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
    prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return { user: session.user, sessionId: session.id };
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const auth = await authenticateToken(req.cookies?.[SESSION_COOKIE]);
    if (auth) {
      req.user = auth.user;
      req.sessionId = auth.sessionId;
    }
    next();
  } catch (err) {
    next(err);
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  await optionalAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.user) return next(new HttpError(401, 'Please sign in to continue', 'UNAUTHENTICATED'));
    next();
  });
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') return next(new HttpError(403, 'Admins only', 'FORBIDDEN'));
  next();
}
