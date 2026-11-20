import { api } from '../../lib/api';
import type { PlanTier } from '../../lib/types';

export interface Quota {
  plan: PlanTier;
  planExpired: boolean;
  dailyLimit: number;
  monthlyLimit: number;
  usedToday: number;
  usedThisMonth: number;
  remainingToday: number;
  remainingThisMonth: number;
  resetsAt: string;
  duplicateWindowHours: number;
}

export type DownloadStatus = 'AUTHORIZED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED';

export interface DownloadItem {
  id: string;
  video: { id: string; title: string; durationSec: number; isPremium: boolean; thumbnailUrl: string };
  status: DownloadStatus;
  plan: PlanTier;
  countsToQuota: boolean;
  fileSizeBytes: number;
  bytesSent: number;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  url: string | null;
}

export interface AuthorizeResult {
  downloadId: string;
  url: string;
  countsToQuota: boolean;
  quota: Quota;
}

export const downloadsApi = {
  quota: () => api.get<Quota>('/downloads/quota'),
  list: (page = 1) =>
    api.get<{ items: DownloadItem[]; total: number; page: number; pageSize: number; quota: Quota }>(`/downloads?page=${page}`),
  authorize: (videoId: string) => api.post<AuthorizeResult>('/downloads/authorize', { videoId }),
  retry: (id: string) => api.post<AuthorizeResult>(`/downloads/${id}/retry`),
};

/** Hand the URL to the browser's download manager (same-origin, cookie-authenticated). */
export function startBrowserDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Friendly copy per server error code; `upgrade` → show a link to /plans. */
export const ERROR_COPY: Record<string, { title: string; upgrade?: boolean }> = {
  DAILY_LIMIT: { title: 'Daily download limit reached', upgrade: true },
  MONTHLY_LIMIT: { title: 'Monthly download limit reached', upgrade: true },
  PLAN_EXPIRED: { title: 'Your subscription has expired', upgrade: true },
  PREMIUM_REQUIRED: { title: 'Premium video', upgrade: true },
  EXCLUSIVE_REQUIRED: { title: 'Gold-exclusive course', upgrade: true },
  EARLY_ACCESS: { title: 'Gold early access', upgrade: true },
  DEVICE_NOT_REGISTERED: { title: 'Device not registered' },
  NOT_DOWNLOADABLE: { title: 'Download unavailable' },
  RETRY_EXPIRED: { title: 'Retry window passed' },
};
