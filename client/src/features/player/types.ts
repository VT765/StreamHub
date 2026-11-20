export interface VideoProgress {
  positionSec: number;
  durationSec: number;
  completed: boolean;
}

export interface VideoSummary {
  id: string;
  title: string;
  description: string;
  channelName: string;
  durationSec: number;
  fileSizeBytes: number;
  isPremium: boolean;
  /** Gold-only exclusive course. */
  isExclusive: boolean;
  /** Set while a new release is in Gold early access; null once it's public. */
  earlyAccessUntil: string | null;
  isDownloadable: boolean;
  views: number;
  createdAt: string;
  thumbnailUrl: string;
  captionsUrl: string | null;
  streamUrl: string;
  progress?: VideoProgress | null;
}

export type AccessReason = 'PREMIUM_REQUIRED' | 'EXCLUSIVE_REQUIRED' | 'EARLY_ACCESS' | 'DAILY_LIMIT' | 'SIGN_IN' | null;

export interface VideoDetail {
  video: VideoSummary;
  progress: VideoProgress | null;
  access: { allowed: boolean; reason: AccessReason; remainingWatchSeconds: number | null };
  nextVideo: VideoSummary | null;
  features: { plan: string; adFree: boolean; maxQuality: string; dailyWatchMinutes: number | null; fasterStreaming: boolean };
  completePercent: number;
}

export interface ProgressResponse {
  progress: VideoProgress;
  justCompleted: boolean;
  remainingWatchSeconds: number | null;
  limitReached: boolean;
}
