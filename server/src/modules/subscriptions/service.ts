import type { BillingPeriod, Payment, PaymentAction, PlanTier, Subscription, User } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Razorpay from 'razorpay';
import { config } from '../../config.js';
import { HttpError } from '../../lib/http.js';
import { emailLayout, sendMail } from '../../lib/mailer.js';
import { effectivePlan, PERIOD_DAYS, PLANS } from '../../lib/plans.js';
import { prisma, type Tx } from '../../lib/prisma.js';
import { invoicePdf } from './invoice.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Razorpay's minimum order amount (₹1). */
const MIN_AMOUNT = 100;
export const PAID_TIERS: PlanTier[] = ['BRONZE', 'SILVER', 'GOLD'];
export const PERIODS: BillingPeriod[] = ['MONTHLY', 'QUARTERLY', 'YEARLY'];

// ───────────── Razorpay client ─────────────

export function razorpayConfigured() {
  const { keyId, keySecret } = config.razorpay;
  return !!keyId && !!keySecret && !/x{6,}/i.test(keyId) && !/x{6,}/i.test(keySecret);
}

let client: Razorpay | null = null;
export function razorpay() {
  if (!razorpayConfigured()) {
    throw new HttpError(
      503,
      'Payments are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (Test Mode keys) in server/.env and restart the server.',
      'PAYMENTS_NOT_CONFIGURED',
    );
  }
  client ??= new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  return client;
}

function safeEqualHex(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function checkoutSignatureValid(orderId: string, paymentId: string, signature: string) {
  const expected = createHmac('sha256', config.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw body, webhook secret). */
export function webhookSignatureValid(rawBody: Buffer, signature: string) {
  const expected = createHmac('sha256', config.razorpay.webhookSecret).update(rawBody).digest('hex');
  return safeEqualHex(expected, signature);
}

// ───────────── Current state ─────────────

/** The subscription the user is on right now (active or cancelled-but-not-yet-expired). */
export function currentSubscription(userId: string, db: Tx = prisma) {
  const now = new Date();
  return db.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'CANCELLED'] }, startDate: { lte: now }, expiryDate: { gt: now } },
    orderBy: { expiryDate: 'desc' },
  });
}

/** A paid downgrade waiting for the current plan to run out. */
export function scheduledSubscription(userId: string, db: Tx = prisma) {
  return db.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'CANCELLED'] }, startDate: { gt: new Date() } },
    orderBy: { startDate: 'asc' },
  });
}

// ───────────── Pricing ─────────────

export interface Quote {
  plan: PlanTier;
  period: BillingPeriod;
  action: PaymentAction;
  eligible: boolean;
  reason?: string;
  price: number;
  credit: number;
  amount: number;
  /** When the purchased plan starts (downgrades start when the current plan ends). */
  startsAt: Date;
  expiresAt: Date;
}

/** Remaining value of the current subscription, based on what was actually paid for it. */
async function remainingCredit(sub: Subscription) {
  const paid = await prisma.payment.findFirst({
    where: { subscriptionId: sub.id, status: 'PAID' },
    orderBy: { paidAt: 'desc' },
  });
  const value = paid?.amount ?? PLANS[sub.plan].prices[sub.period];
  const total = sub.expiryDate.getTime() - sub.startDate.getTime();
  const left = Math.max(0, sub.expiryDate.getTime() - Date.now());
  if (total <= 0) return 0;
  // Whole rupees keep the quote stable for a while, which lets duplicate clicks reuse the same order.
  return Math.floor((value * left) / total / 100) * 100;
}

/**
 * Plan-change policy:
 * - FREE → paid: NEW, starts now.
 * - Higher tier: UPGRADE, starts now; the unused value of the current plan is credited (prorated).
 * - Same tier: RENEW, any period; the new period is added on top of the current expiry.
 * - Lower tier: DOWNGRADE, paid now but scheduled — it starts when the current plan expires,
 *   so the user keeps what they already paid for.
 * - While a downgrade is scheduled, other purchases are blocked until it starts.
 */
export async function quote(user: User, plan: PlanTier, period: BillingPeriod): Promise<Quote> {
  const now = new Date();
  const price = PLANS[plan].prices[period];
  const days = PERIOD_DAYS[period] * DAY_MS;
  const base = { plan, period, price, credit: 0, amount: price, startsAt: now, expiresAt: new Date(now.getTime() + days) };

  if (plan === 'FREE') {
    return { ...base, action: 'NEW', eligible: false, reason: 'The Free plan needs no payment. Turn off auto-renew to return to Free when your plan ends.' };
  }

  const tier = effectivePlan(user);
  const current = tier === 'FREE' ? null : await currentSubscription(user.id);
  if (!current) return { ...base, action: 'NEW', eligible: true };

  const scheduled = await scheduledSubscription(user.id);
  const blocked = scheduled
    ? `You already have ${PLANS[scheduled.plan].name} scheduled to start on ${scheduled.startDate.toDateString()}.`
    : undefined;

  const curRank = PLANS[current.plan].rank;
  const newRank = PLANS[plan].rank;

  if (newRank > curRank) {
    const credit = Math.min(await remainingCredit(current), Math.max(0, price - MIN_AMOUNT));
    return { ...base, action: 'UPGRADE', credit, amount: price - credit, eligible: !blocked, reason: blocked };
  }
  if (newRank === curRank) {
    const startsAt = current.expiryDate;
    return {
      ...base,
      action: 'RENEW',
      startsAt: now,
      expiresAt: new Date(startsAt.getTime() + days),
      eligible: !blocked,
      reason: blocked,
    };
  }
  return {
    ...base,
    action: 'DOWNGRADE',
    startsAt: current.expiryDate,
    expiresAt: new Date(current.expiryDate.getTime() + days),
    eligible: !blocked,
    reason: blocked,
  };
}

// ───────────── Activation ─────────────

function invoicePrefix(d = new Date()) {
  return `SH-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export interface ActivationResult {
  payment: Payment;
  subscription: Subscription | null;
  alreadyProcessed: boolean;
}

/**
 * Mark the order PAID and apply the plan change, exactly once. Called by /verify and by the
 * webhook; the conditional update means whichever arrives second sees alreadyProcessed.
 */
export async function activatePayment(orderId: string, paymentId: string, signature: string | null): Promise<ActivationResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const now = new Date();
        const { count } = await tx.payment.updateMany({
          where: { razorpayOrderId: orderId, status: { not: 'PAID' } },
          data: { status: 'PAID', razorpayPaymentId: paymentId, razorpaySignature: signature, paidAt: now, failureReason: null },
        });
        const payment = await tx.payment.findUnique({ where: { razorpayOrderId: orderId } });
        if (!payment) throw new HttpError(404, 'Order not found', 'ORDER_NOT_FOUND');
        if (count === 0) {
          const subscription = payment.subscriptionId
            ? await tx.subscription.findUnique({ where: { id: payment.subscriptionId } })
            : null;
          return { payment, subscription, alreadyProcessed: true };
        }

        const paidCount = await tx.payment.count({ where: { status: 'PAID', invoiceNumber: { startsWith: invoicePrefix(now) } } });
        const invoiceNumber = `${invoicePrefix(now)}-${String(paidCount + 1).padStart(6, '0')}`;

        const days = PERIOD_DAYS[payment.period] * DAY_MS;
        const current = await currentSubscription(payment.userId, tx);
        let startDate = now;
        let expiryDate = new Date(now.getTime() + days);

        if (payment.action === 'RENEW' && current && current.plan === payment.plan) {
          expiryDate = new Date(current.expiryDate.getTime() + days);
        } else if (payment.action === 'DOWNGRADE' && current && PLANS[current.plan].rank > PLANS[payment.plan].rank) {
          startDate = current.expiryDate;
          expiryDate = new Date(startDate.getTime() + days);
        }
        const startsNow = startDate.getTime() <= now.getTime();

        if (startsNow) {
          await tx.subscription.updateMany({
            where: { userId: payment.userId, status: { in: ['ACTIVE', 'CANCELLED'] }, startDate: { lte: now } },
            data: { status: 'SUPERSEDED' },
          });
        }
        const subscription = await tx.subscription.create({
          data: { userId: payment.userId, plan: payment.plan, period: payment.period, startDate, expiryDate, autoRenew: true },
        });
        if (startsNow) {
          await tx.user.update({ where: { id: payment.userId }, data: { plan: payment.plan, planExpiresAt: expiryDate } });
        }
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: { subscriptionId: subscription.id, invoiceNumber },
        });
        return { payment: updated, subscription, alreadyProcessed: false };
      });

      if (!result.alreadyProcessed) void sendConfirmationEmail(result.payment.id).catch(console.error);
      return result;
    } catch (err) {
      // Two activations in the same instant can race for an invoice number; retry.
      if (err instanceof PrismaNS.PrismaClientKnownRequestError && (err.code === 'P2002' || err.code === 'P2034') && attempt < 3) continue;
      throw err;
    }
  }
}

export async function markPaymentFailed(orderId: string, reason: string) {
  return prisma.payment.updateMany({
    where: { razorpayOrderId: orderId, status: { in: ['CREATED', 'CANCELLED'] } },
    data: { status: 'FAILED', failureReason: reason.slice(0, 300) },
  });
}

// ───────────── Email ─────────────

function rupees(paise: number) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });

export async function sendConfirmationEmail(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { user: true, subscription: true },
  });
  if (!payment || payment.status !== 'PAID' || payment.emailSentAt || !payment.subscription) return;
  const { user, subscription: sub } = payment;
  const plan = PLANS[payment.plan];
  const scheduled = sub.startDate.getTime() > Date.now() + 60_000;

  const rows: [string, string][] = [
    ['Invoice number', payment.invoiceNumber ?? '—'],
    ['Plan', `${plan.name} (${payment.period.toLowerCase()})`],
    ['Type', payment.action.charAt(0) + payment.action.slice(1).toLowerCase()],
    ['Amount paid', `${rupees(payment.amount)} ${payment.currency}`],
    ['Payment ID', payment.razorpayPaymentId ?? '—'],
    ['Order ID', payment.razorpayOrderId],
    ['Paid on', payment.paidAt ? payment.paidAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'],
    ['Valid from', fmtDate(sub.startDate)],
    ['Valid until', fmtDate(sub.expiryDate)],
    ['Renewal', sub.autoRenew ? `Renewal reminder before ${fmtDate(sub.expiryDate)}` : 'Auto-renew off'],
  ];
  const table = rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#71717a">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600">${v}</td></tr>`)
    .join('');

  const pdf = await invoicePdf(payment, user, sub);
  const sent = await sendMail({
    to: user.email,
    subject: `Payment received — StreamHub ${plan.name} (${payment.invoiceNumber})`,
    html: emailLayout(
      `Thanks, ${user.name.split(' ')[0]}! Your ${plan.name} plan ${scheduled ? 'is scheduled' : 'is active'}.`,
      `<p>${scheduled ? `Your ${plan.name} plan starts on ${fmtDate(sub.startDate)}, when your current plan ends.` : 'Your premium features are unlocked now.'}</p>
       <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-top:1px solid #e4e4e7;border-bottom:1px solid #e4e4e7;margin:16px 0">${table}</table>
       <p>Your invoice and payment receipt are attached as a PDF. You can also download them any time from your subscription dashboard.</p>
       <p style="color:#71717a;font-size:13px">This was a Razorpay test-mode transaction.</p>`,
    ),
    attachments: [{ filename: `${payment.invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  if (sent) await prisma.payment.update({ where: { id: payment.id }, data: { emailSentAt: new Date() } });
}

export function planChangeEmail(user: User, title: string, body: string) {
  return sendMail({ to: user.email, subject: title, html: emailLayout(title, body) });
}

export { fmtDate, rupees };
