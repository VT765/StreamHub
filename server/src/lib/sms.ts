import { config } from '../config.js';

/** SMS is optional: sign-in codes go by SMS only when a Twilio account is configured. */
export function smsConfigured() {
  const { accountSid, authToken, from } = config.sms;
  return !!(accountSid && authToken && from);
}

/** E.164 for Twilio; bare 10-digit numbers are treated as Indian (+91). */
export function toE164(phone: string) {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (/^\d{10}$/.test(digits)) return `+91${digits}`;
  return `+${digits}`;
}

/** Sends a text through Twilio's REST API. Throws on failure so callers can fall back to email. */
export async function sendSms(to: string, body: string) {
  const { accountSid, authToken, from } = config.sms;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: toE164(to), From: from, Body: body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(`SMS failed (${res.status}): ${detail.message ?? res.statusText}`);
  }
}
