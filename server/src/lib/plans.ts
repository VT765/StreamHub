import type { BillingPeriod, PlanTier, User } from '@prisma/client';

export interface PlanFeatures {
  tier: PlanTier;
  name: string;
  rank: number;
  tagline: string;
  /** Prices in paise. */
  prices: Record<BillingPeriod, number>;
  downloadsPerDay: number;
  downloadsPerMonth: number;
  /** null = unlimited */
  dailyWatchMinutes: number | null;
  maxQuality: '480p' | '720p' | '1080p' | '4K';
  premiumVideos: boolean;
  offlineDownloads: boolean;
  adFree: boolean;
  priorityAccess: boolean;
  exclusiveCourses: boolean;
  fasterStreaming: boolean;
}

export const PERIOD_DAYS: Record<BillingPeriod, number> = { MONTHLY: 30, QUARTERLY: 90, YEARLY: 365 };

export const PLANS: Record<PlanTier, PlanFeatures> = {
  FREE: {
    tier: 'FREE', name: 'Free', rank: 0, tagline: 'Get started at no cost',
    prices: { MONTHLY: 0, QUARTERLY: 0, YEARLY: 0 },
    downloadsPerDay: 1, downloadsPerMonth: 30, dailyWatchMinutes: 60, maxQuality: '480p',
    premiumVideos: false, offlineDownloads: true, adFree: false, priorityAccess: false, exclusiveCourses: false, fasterStreaming: false,
  },
  BRONZE: {
    tier: 'BRONZE', name: 'Bronze', rank: 1, tagline: 'Unlimited watching, more downloads',
    prices: { MONTHLY: 99_00, QUARTERLY: 279_00, YEARLY: 999_00 },
    downloadsPerDay: 5, downloadsPerMonth: 100, dailyWatchMinutes: null, maxQuality: '720p',
    premiumVideos: true, offlineDownloads: true, adFree: false, priorityAccess: false, exclusiveCourses: false, fasterStreaming: false,
  },
  SILVER: {
    tier: 'SILVER', name: 'Silver', rank: 2, tagline: 'Full HD and ad-free',
    prices: { MONTHLY: 199_00, QUARTERLY: 549_00, YEARLY: 1999_00 },
    downloadsPerDay: 15, downloadsPerMonth: 300, dailyWatchMinutes: null, maxQuality: '1080p',
    premiumVideos: true, offlineDownloads: true, adFree: true, priorityAccess: false, exclusiveCourses: false, fasterStreaming: true,
  },
  GOLD: {
    tier: 'GOLD', name: 'Gold', rank: 3, tagline: 'Everything, including exclusive courses',
    prices: { MONTHLY: 299_00, QUARTERLY: 849_00, YEARLY: 2999_00 },
    downloadsPerDay: 50, downloadsPerMonth: 1000, dailyWatchMinutes: null, maxQuality: '4K',
    premiumVideos: true, offlineDownloads: true, adFree: true, priorityAccess: true, exclusiveCourses: true, fasterStreaming: true,
  },
};

/**
 * The plan a user is actually entitled to right now. A paid plan whose expiry has passed
 * is treated as FREE immediately, even before the expiry job downgrades the row.
 */
export function effectivePlan(user: Pick<User, 'plan' | 'planExpiresAt'>): PlanTier {
  if (user.plan === 'FREE') return 'FREE';
  if (!user.planExpiresAt || user.planExpiresAt.getTime() <= Date.now()) return 'FREE';
  return user.plan;
}

export type ContentBlock = 'EXCLUSIVE_REQUIRED' | 'EARLY_ACCESS' | 'PREMIUM_REQUIRED';

/**
 * Plan-based content rules shared by watching, streaming and downloads:
 * exclusive courses need exclusiveCourses, early-access releases need priorityAccess until they go
 * public, and premium videos need premiumVideos.
 */
export function contentBlock(
  plan: PlanTier,
  video: { isPremium: boolean; isExclusive: boolean; earlyAccessUntil: Date | null },
  now = new Date(),
): ContentBlock | null {
  const f = PLANS[plan];
  if (video.isExclusive && !f.exclusiveCourses) return 'EXCLUSIVE_REQUIRED';
  if (video.earlyAccessUntil && video.earlyAccessUntil > now && !f.priorityAccess) return 'EARLY_ACCESS';
  if (video.isPremium && !f.premiumVideos) return 'PREMIUM_REQUIRED';
  return null;
}

export function planFeatures(user: Pick<User, 'plan' | 'planExpiresAt'>): PlanFeatures {
  return PLANS[effectivePlan(user)];
}
