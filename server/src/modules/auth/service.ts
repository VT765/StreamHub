import type { Response } from 'express';
import type { LoginStatus, OtpChannel, User } from '@prisma/client';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import type { ClientInfo } from '../../lib/clientInfo.js';
import { HttpError } from '../../lib/http.js';
import { emailLayout, sendMail } from '../../lib/mailer.js';
import { sendSms, smsConfigured } from '../../lib/sms.js';
import { prisma } from '../../lib/prisma.js';
import { themeForLoginTime } from '../../lib/time.js';
import { setSessionCookie, signSessionToken } from '../../middleware/auth.js';

export type RiskReason = 'NEW_BROWSER' | 'NEW_DEVICE' | 'NEW_IP' | 'NEW_LOCATION';

export function publicUser(user: User) {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export async function recordLogin(
  status: LoginStatus,
  email: string,
  info: ClientInfo,
  userId: string | null,
  reasons: RiskReason[] = [],
) {
  await prisma.loginEvent.create({
    data: {
      userId,
      email,
      status,
      reasons,
      ip: info.ip,
      browser: info.browser,
      browserVersion: info.browserVersion,
      os: info.os,
      osVersion: info.osVersion,
      deviceType: info.deviceType,
      deviceModel: info.deviceModel,
      city: info.city,
      state: info.state,
      country: info.country,
      latitude: info.latitude,
      longitude: info.longitude,
      userAgent: info.userAgent.slice(0, 500),
    },
  });
}

/**
 * Compare this login against the user's verified history.
 * - NEW_BROWSER: browser family never seen in a successful login.
 * - NEW_DEVICE: this browser's device key isn't a currently trusted device.
 * - NEW_IP: IP never seen in a successful login.
 * - NEW_LOCATION: city/state never seen in a successful login.
 *
 * A trusted device (verified via OTP within TRUSTED_DEVICE_DAYS) skips the browser/device/IP
 * checks, but a change of city or state still requires OTP.
 */
export async function assessLoginRisk(user: User, info: ClientInfo): Promise<RiskReason[]> {
  const history = await prisma.loginEvent.findMany({
    where: { userId: user.id, status: { in: ['SUCCESS', 'OTP_VERIFIED'] } },
    select: { browser: true, ip: true, city: true, state: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const trusted = info.deviceKey
    ? await prisma.trustedDevice.findUnique({ where: { userId_deviceKey: { userId: user.id, deviceKey: info.deviceKey } } })
    : null;
  const isTrusted =
    !!trusted && !trusted.revokedAt && trusted.trustedUntil > new Date() && trusted.fingerprint === info.fingerprint;

  const reasons: RiskReason[] = [];
  if (!isTrusted) {
    if (info.browser && !history.some((h) => h.browser === info.browser)) reasons.push('NEW_BROWSER');
    reasons.push('NEW_DEVICE');
    if (info.ip && !history.some((h) => h.ip === info.ip)) reasons.push('NEW_IP');
  }
  const knownLocation = history.some(
    (h) => (!info.city || h.city === info.city) && (!info.state || h.state === info.state),
  );
  if ((info.city || info.state) && !knownLocation) reasons.push('NEW_LOCATION');
  return reasons;
}

// ───────────── OTP ─────────────

function hashOtp(challengeId: string, code: string) {
  return createHmac('sha256', config.jwtSecret).update(`${challengeId}:${code}`).digest('hex');
}

export function otpMatches(challengeId: string, code: string, hash: string) {
  const a = Buffer.from(hashOtp(challengeId, code));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function maskDestination(user: User, channel: OtpChannel) {
  if (channel === 'SMS' && user.phone) return user.phone.replace(/.(?=.{3})/g, '•');
  const [local, domain] = user.email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export async function issueOtp(user: User, channel: OtpChannel, info: ClientInfo, reasons: RiskReason[]) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const challenge = await prisma.otpChallenge.create({
    data: {
      userId: user.id,
      channel,
      codeHash: 'pending',
      expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60_000),
      context: { ...info, reasons } as object,
    },
  });
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { codeHash: hashOtp(challenge.id, code) } });
  await deliverOtp(user, channel, code, info, reasons);
  return challenge;
}

/** Re-send: new code on the same challenge, attempts reset. */
export async function reissueOtp(challengeId: string, user: User, channel: OtpChannel) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const existing = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId }, select: { context: true } });
  const ctx = existing.context as unknown as ClientInfo & { reasons: RiskReason[] };
  // Deliver first: if sending fails (e.g. SMS), the code the user already has keeps working.
  await deliverOtp(user, channel, code, ctx, ctx.reasons ?? []);
  return prisma.otpChallenge.update({
    where: { id: challengeId },
    data: {
      channel,
      codeHash: hashOtp(challengeId, code),
      attempts: 0,
      expiresAt: new Date(Date.now() + config.otpTtlMinutes * 60_000),
    },
  });
}

const REASON_TEXT: Record<RiskReason, string> = {
  NEW_BROWSER: 'a new browser',
  NEW_DEVICE: 'a new device',
  NEW_IP: 'a new IP address',
  NEW_LOCATION: 'a new location',
};

async function deliverOtp(user: User, channel: OtpChannel, code: string, info: ClientInfo, reasons: RiskReason[]) {
  const where = [info.city, info.state, info.country].filter(Boolean).join(', ') || 'an unknown location';
  const why = reasons.map((r) => REASON_TEXT[r]).join(', ') || 'a new sign-in';

  if (channel === 'SMS') {
    if (config.isDev) console.log(`[otp:sms] ${user.phone} → ${code}`);
    if (!smsConfigured() || !user.phone) throw new HttpError(400, 'SMS codes aren’t available. Use the code sent to your email.', 'SMS_UNAVAILABLE');
    try {
      await sendSms(user.phone, `${code} is your StreamHub verification code. It expires in ${config.otpTtlMinutes} minutes.`);
    } catch (err) {
      console.error('[otp:sms]', err);
      throw new HttpError(502, 'We couldn’t send the SMS. Try again, or use the code sent to your email.', 'SMS_FAILED');
    }
    return;
  }
  if (config.isDev) console.log(`[otp:email] ${user.email} → ${code}`);
  await sendMail({
    to: user.email,
    subject: `${code} is your StreamHub verification code`,
    html: emailLayout(
      'Verify it’s you',
      `<p>We noticed a sign-in from ${why}:</p>
       <p style="color:#52525b">${info.browser ?? 'Unknown browser'} on ${info.os ?? 'unknown OS'} (${info.deviceType}) · ${where} · IP ${info.ip ?? 'unknown'}</p>
       <p>Your verification code is:</p>
       <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:12px 0">${code}</p>
       <p style="color:#52525b">It expires in ${config.otpTtlMinutes} minutes. If this wasn’t you, change your password right away.</p>`,
    ),
    text: `Your StreamHub verification code is ${code}. It expires in ${config.otpTtlMinutes} minutes.`,
  });
}

// ───────────── Session completion ─────────────

export async function trustDevice(user: User, info: ClientInfo) {
  if (!info.deviceKey) return null;
  const trustedUntil = new Date(Date.now() + config.trustedDeviceDays * 24 * 60 * 60 * 1000);
  const label = `${info.browser ?? 'Browser'} on ${info.os ?? 'Unknown OS'}${info.deviceModel ? ` (${info.deviceModel})` : ''}`;
  const data = {
    fingerprint: info.fingerprint,
    label,
    browser: info.browser,
    os: info.os,
    deviceType: info.deviceType,
    lastIp: info.ip,
    lastCity: info.city,
    lastState: info.state,
    trustedUntil,
    revokedAt: null,
    lastUsedAt: new Date(),
  };
  return prisma.trustedDevice.upsert({
    where: { userId_deviceKey: { userId: user.id, deviceKey: info.deviceKey } },
    create: { userId: user.id, deviceKey: info.deviceKey, ...data },
    update: data,
  });
}

/**
 * Create the session, apply the login-time theme (unless the user picked one manually),
 * and set the cookie.
 */
export async function completeLogin(res: Response, user: User, info: ClientInfo) {
  const trusted = info.deviceKey
    ? await prisma.trustedDevice.findUnique({ where: { userId_deviceKey: { userId: user.id, deviceKey: info.deviceKey } } })
    : null;
  const activeTrusted = trusted && !trusted.revokedAt && trusted.trustedUntil > new Date() ? trusted : null;
  if (activeTrusted) {
    await prisma.trustedDevice.update({
      where: { id: activeTrusted.id },
      data: { lastUsedAt: new Date(), lastIp: info.ip, lastCity: info.city, lastState: info.state },
    });
  }

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      trustedDeviceId: activeTrusted?.id ?? null,
      ip: info.ip,
      browser: info.browser,
      os: info.os,
      deviceType: info.deviceType,
      city: info.city,
    },
  });

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      ...(user.themeManuallySet ? {} : { theme: themeForLoginTime() }),
      city: info.city ?? user.city,
      state: info.state ?? user.state,
      country: info.country ?? user.country,
    },
  });

  setSessionCookie(res, signSessionToken(user.id, session.id));
  return publicUser(updated);
}
