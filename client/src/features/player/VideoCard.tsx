import { CheckCircle2, Crown, GraduationCap, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatDuration, timeAgo } from '../../lib/format';
import type { VideoSummary } from './types';

export function formatViews(n: number) {
  return `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(n)} view${n === 1 ? '' : 's'}`;
}

export function VideoCard({ video, compact }: { video: VideoSummary; compact?: boolean }) {
  const p = video.progress;
  const pct = p && p.durationSec ? Math.min(100, (p.positionSec / p.durationSec) * 100) : 0;
  return (
    <Link to={`/watch/${video.id}`} className={`vcard ${compact ? 'compact' : ''}`}>
      <div className="vcard-thumb">
        <img src={video.thumbnailUrl} alt="" loading="lazy" />
        {video.isExclusive ? (
          <span className="badge plan-GOLD vcard-premium">
            <GraduationCap size={12} /> Gold course
          </span>
        ) : video.earlyAccessUntil ? (
          <span className="badge plan-GOLD vcard-premium">
            <Sparkles size={12} /> Early access
          </span>
        ) : (
          video.isPremium && (
            <span className="badge plan-GOLD vcard-premium">
              <Crown size={12} /> Premium
            </span>
          )
        )}
        <span className="vcard-duration">{formatDuration(video.durationSec)}</span>
        {p?.completed ? (
          <span className="badge success vcard-done">
            <CheckCircle2 size={12} /> Watched
          </span>
        ) : (
          pct > 0 && (
            <div className="vcard-progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          )
        )}
      </div>
      <div>
        <div className="vcard-title">{video.title}</div>
        <div className="vcard-meta">{video.channelName}</div>
        <div className="vcard-meta">
          {formatViews(video.views)} · {timeAgo(video.createdAt)}
        </div>
      </div>
    </Link>
  );
}

export function VideoCardSkeleton() {
  return (
    <div className="vcard">
      <div className="vcard-thumb skeleton" />
      <div className="skeleton" style={{ height: 16, width: '80%' }} />
      <div className="skeleton" style={{ height: 12, width: '50%' }} />
    </div>
  );
}
