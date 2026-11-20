import 'dotenv/config';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isDev: (process.env.NODE_ENV ?? 'development') !== 'production',
  port: num('PORT', 4000),
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:5173',
  // Reverse proxies in front of the API (production: Vercel rewrite + Render load balancer = 2).
  trustProxyHops: num('TRUST_PROXY_HOPS', 1),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  otpTtlMinutes: num('OTP_TTL_MINUTES', 10),
  otpMaxAttempts: num('OTP_MAX_ATTEMPTS', 5),
  trustedDeviceDays: num('TRUSTED_DEVICE_DAYS', 30),
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: num('SMTP_PORT', 1025),
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.MAIL_FROM ?? 'StreamHub <no-reply@streamhub.local>',
  },
  // Optional: Twilio (free trial works for verified numbers). Without it, codes go by email only.
  sms: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM_NUMBER || '',
  },
  supportEmail: process.env.SUPPORT_EMAIL ?? 'support@streamhub.local',
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  },
  downloads: {
    requireRegisteredDevice: process.env.DOWNLOADS_REQUIRE_REGISTERED_DEVICE === 'true',
    duplicateWindowHours: num('DUPLICATE_DOWNLOAD_WINDOW_HOURS', 24),
  },
  comments: {
    libreTranslateUrl: process.env.LIBRETRANSLATE_URL || '',
    libreTranslateKey: process.env.LIBRETRANSLATE_API_KEY || '',
    editWindowMinutes: num('COMMENT_EDIT_WINDOW_MINUTES', 15),
  },
  meetings: {
    maxParticipants: num('MEETING_MAX_PARTICIPANTS', 8),
    turnUrl: process.env.TURN_URL || '',
    turnUsername: process.env.TURN_USERNAME || '',
    turnCredential: process.env.TURN_CREDENTIAL || '',
  },
} as const;
