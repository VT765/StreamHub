import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../../config.js';
import { getClientInfo, type ClientInfo } from '../../lib/clientInfo.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { smsConfigured } from '../../lib/sms.js';
import { clearSessionCookie, requireAuth, signSocketToken } from '../../middleware/auth.js';
import {
  assessLoginRisk,
  completeLogin,
  issueOtp,
  maskDestination,
  otpMatches,
  publicUser,
  recordLogin,
  reissueOtp,
  trustDevice,
  type RiskReason,
} from './service.js';

export const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const otpLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  username: z
    .string()
    .trim()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_.]+$/, 'Only letters, numbers, underscore and dot'),
  email: z.string().trim().toLowerCase().email(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{10,15}$/, 'Enter a valid mobile number')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  password: z.string().min(8).max(128),
});

router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const exists = await prisma.user.findFirst({
      where: { OR: [{ email: body.email }, { username: { equals: body.username, mode: 'insensitive' } }] },
    });
    if (exists) {
      throw new HttpError(409, exists.email === body.email ? 'Email already registered' : 'Username is taken', 'CONFLICT');
    }
    const info = await getClientInfo(req);
    const user = await prisma.user.create({
      data: {
        name: body.name,
        username: body.username,
        email: body.email,
        phone: body.phone,
        passwordHash: await bcrypt.hash(body.password, 12),
        city: info.city,
        state: info.state,
        country: info.country,
      },
    });
    // The device you sign up on is your first trusted device.
    await trustDevice(user, info);
    await recordLogin('SUCCESS', user.email, info, user.id);
    res.status(201).json({ user: await completeLogin(res, user, info) });
  }),
);

const loginSchema = z.object({
  identifier: z.string().trim().min(3), // email or username
  password: z.string().min(1),
});

router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { identifier, password } = loginSchema.parse(req.body);
    const info = await getClientInfo(req);
    const user = await prisma.user.findFirst({
      where: identifier.includes('@')
        ? { email: identifier.toLowerCase() }
        : { username: { equals: identifier, mode: 'insensitive' } },
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      await recordLogin('FAILED_PASSWORD', user?.email ?? identifier, info, user?.id ?? null);
      throw new HttpError(401, 'Incorrect email/username or password', 'BAD_CREDENTIALS');
    }

    const reasons = await assessLoginRisk(user, info);
    if (reasons.length === 0) {
      await recordLogin('SUCCESS', user.email, info, user.id);
      return res.json({ user: await completeLogin(res, user, info) });
    }

    const challenge = await issueOtp(user, 'EMAIL', info, reasons);
    await recordLogin('OTP_REQUIRED', user.email, info, user.id, reasons);
    res.json({
      otpRequired: true,
      challengeId: challenge.id,
      channel: challenge.channel,
      destination: maskDestination(user, 'EMAIL'),
      smsAvailable: !!user.phone && smsConfigured(),
      reasons,
      expiresAt: challenge.expiresAt,
    });
  }),
);

async function loadOpenChallenge(challengeId: string) {
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
  if (!challenge || challenge.consumedAt) throw new HttpError(400, 'This verification request is no longer valid. Please sign in again.', 'OTP_INVALID');
  return challenge;
}

router.post(
  '/otp/verify',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { challengeId, code, trustDevice: trust } = z
      .object({ challengeId: z.string(), code: z.string().regex(/^\d{6}$/), trustDevice: z.boolean().default(true) })
      .parse(req.body);
    const challenge = await loadOpenChallenge(challengeId);
    const ctx = challenge.context as unknown as ClientInfo & { reasons: RiskReason[] };

    if (challenge.expiresAt < new Date()) throw new HttpError(400, 'Code expired. Request a new one.', 'OTP_EXPIRED');
    if (challenge.attempts >= config.otpMaxAttempts) {
      throw new HttpError(429, 'Too many wrong attempts. Request a new code.', 'OTP_LOCKED');
    }

    if (!otpMatches(challenge.id, code, challenge.codeHash)) {
      const updated = await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      await recordLogin('OTP_FAILED', challenge.user.email, ctx, challenge.userId, ctx.reasons);
      throw new HttpError(400, 'Incorrect code', 'OTP_WRONG', {
        attemptsLeft: Math.max(0, config.otpMaxAttempts - updated.attempts),
      });
    }

    // Consume atomically so a double-submit can't create two sessions.
    const { count } = await prisma.otpChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) throw new HttpError(400, 'Code already used', 'OTP_INVALID');

    // Verify against the device that requested the code, not whatever sent this request.
    const live = await getClientInfo(req);
    const info: ClientInfo = { ...ctx, deviceKey: live.deviceKey ?? ctx.deviceKey };
    if (trust) await trustDevice(challenge.user, info);
    await recordLogin('OTP_VERIFIED', challenge.user.email, info, challenge.userId, ctx.reasons);
    res.json({ user: await completeLogin(res, challenge.user, info) });
  }),
);

router.post(
  '/otp/resend',
  otpLimiter,
  asyncHandler(async (req, res) => {
    const { challengeId, channel } = z
      .object({ challengeId: z.string(), channel: z.enum(['EMAIL', 'SMS']).default('EMAIL') })
      .parse(req.body);
    const challenge = await loadOpenChallenge(challengeId);
    if (channel === 'SMS' && !challenge.user.phone) throw new HttpError(400, 'No mobile number on this account');
    if (channel === 'SMS' && !smsConfigured()) throw new HttpError(400, 'SMS codes aren’t available. Use the code sent to your email.', 'SMS_UNAVAILABLE');
    if (Date.now() - challenge.createdAt.getTime() < 30_000 && challenge.channel === channel && challenge.attempts === 0) {
      throw new HttpError(429, 'Please wait a few seconds before requesting another code', 'OTP_COOLDOWN');
    }
    const updated = await reissueOtp(challenge.id, challenge.user, channel);
    res.json({ channel, destination: maskDestination(challenge.user, channel), expiresAt: updated.expiresAt });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: publicUser(req.user!) });
  }),
);

/** Short-lived token the meeting client uses to open its socket directly to this API host. */
router.get(
  '/socket-token',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ token: signSocketToken(req.user!.id, req.sessionId!) });
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await prisma.session.update({ where: { id: req.sessionId! }, data: { revokedAt: new Date() } });
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);
