import { Clock, Crown, GraduationCap, Lock, LogIn, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Avatar } from '../../components/Avatar';
import { api, errorMessage } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { CommentsSection } from '../comments/CommentsSection';
import { DownloadButton } from '../downloads/DownloadButton';
import type { AccessReason, VideoDetail, VideoSummary } from './types';
import { formatViews, VideoCard } from './VideoCard';
import { VideoPlayer } from './VideoPlayer';
import './player.css';

const THEATER_KEY = 'sh_theater';

function readTheater() {
  try {
    return localStorage.getItem(THEATER_KEY) === '1';
  } catch {
    return false;
  }
}

export function WatchPage() {
  const { videoId } = useParams<{ videoId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<VideoDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upNext, setUpNext] = useState<VideoSummary[]>([]);
  const [theater, setTheater] = useState(readTheater);
  const [gate, setGate] = useState<AccessReason>(null);
  const [adDismissed, setAdDismissed] = useState(false);
  const [completed, setCompleted] = useState(false);

  const load = useCallback(async () => {
    if (!videoId) return;
    try {
      const d = await api.get<VideoDetail>(`/videos/${encodeURIComponent(videoId)}`);
      setData(d);
      setGate(d.access.allowed ? null : d.access.reason);
      setCompleted(!!d.progress?.completed);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [videoId]);

  useEffect(() => {
    setData(null);
    void load();
    window.scrollTo({ top: 0 });
  }, [load, user?.id]);

  useEffect(() => {
    api
      .get<{ items: VideoSummary[] }>('/videos')
      .then((r) => setUpNext(r.items.filter((v) => v.id !== videoId)))
      .catch(() => {});
  }, [videoId, user?.id]);

  const toggleTheater = useCallback(() => {
    setTheater((t) => {
      try {
        localStorage.setItem(THEATER_KEY, t ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !t;
    });
  }, []);

  const goNext = useCallback(() => {
    if (data?.nextVideo) navigate(`/watch/${data.nextVideo.id}`);
  }, [data?.nextVideo, navigate]);

  const onLimitReached = useCallback(() => setGate('DAILY_LIMIT'), []);
  const onCompleted = useCallback(() => setCompleted(true), []);

  if (error) {
    return (
      <div className="container">
        <div className="alert error">{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="watch">
        <div className="watch-stage">
          <div className="skeleton" style={{ aspectRatio: '16 / 9' }} />
        </div>
      </div>
    );
  }

  const { video } = data;
  const next = data.nextVideo;

  return (
    <div className={`watch ${theater ? 'theater' : ''}`}>
      <div className="watch-stage">
        {gate ? (
          <AccessGate reason={gate} video={video} dailyMinutes={data.features.dailyWatchMinutes} />
        ) : (
          <VideoPlayer
            video={video}
            startAt={data.progress?.positionSec ?? 0}
            nextVideo={next}
            onNext={goNext}
            theater={theater}
            onToggleTheater={toggleTheater}
            planMaxQuality={data.features.maxQuality}
            fasterStreaming={data.features.fasterStreaming}
            completePercent={data.completePercent}
            trackProgress={!!user}
            remainingWatchSeconds={data.access.remainingWatchSeconds}
            onLimitReached={onLimitReached}
            onCompleted={onCompleted}
            onPlaybackError={() => void load()}
          />
        )}
      </div>

      <div className="watch-main">
        {!data.features.adFree && !adDismissed && (
          <div className="ad-banner" role="complementary" aria-label="Advertisement">
            <span className="ad-tag">AD</span>
            <span>
              Go ad-free with <b>Silver</b> or <b>Gold</b> — plus Full HD and more downloads.
            </span>
            <span className="spacer" />
            <Link to="/plans" className="btn sm primary">See plans</Link>
            <button className="btn ghost icon sm" onClick={() => setAdDismissed(true)} aria-label="Dismiss ad">
              <X size={16} />
            </button>
          </div>
        )}

        <h1 className="watch-title">{video.title}</h1>
        <div className="watch-meta">
          <div className="watch-channel">
            <Avatar name={video.channelName} size={36} />
            <div>
              <div style={{ fontWeight: 700 }}>{video.channelName}</div>
              <div className="subtle">
                {formatViews(video.views)} · {formatDate(video.createdAt)}
              </div>
            </div>
          </div>
          {video.isPremium && (
            <span className="badge plan-GOLD">
              <Crown size={12} /> Premium
            </span>
          )}
          {completed && <span className="badge success">Completed</span>}
          <span className="spacer" />
          <DownloadButton videoId={video.id} title={video.title} />
        </div>
        {video.description && <div className="watch-desc">{video.description}</div>}
        {user && data.access.remainingWatchSeconds !== null && !gate && (
          <div className="subtle">
            <Clock size={12} style={{ verticalAlign: -1 }} /> Free plan: about{' '}
            {Math.max(0, Math.round(data.access.remainingWatchSeconds / 60))} min of watch time left today.{' '}
            <Link to="/plans" style={{ color: 'var(--accent)' }}>Upgrade for unlimited</Link>
          </div>
        )}

        <CommentsSection videoId={video.id} />
      </div>

      <aside className="watch-side">
        <h2 className="section-title" style={{ margin: 0 }}>Up next</h2>
        {upNext.map((v) => (
          <VideoCard key={v.id} video={v} compact />
        ))}
      </aside>
    </div>
  );
}

function AccessGate({ reason, video, dailyMinutes }: { reason: AccessReason; video: VideoSummary; dailyMinutes: number | null }) {
  const copy = {
    SIGN_IN: {
      icon: <LogIn size={32} />,
      title: 'Sign in to watch',
      body: 'This video is for subscribers. Sign in with a plan that includes it to watch.',
      cta: <Link to="/login" state={{ from: `/watch/${video.id}` }} className="btn primary">Sign in</Link>,
    },
    PREMIUM_REQUIRED: {
      icon: <Lock size={32} />,
      title: 'Premium video',
      body: 'Upgrade to Bronze, Silver or Gold to unlock premium videos.',
      cta: <Link to="/plans" className="btn primary"><Crown size={16} /> View plans</Link>,
    },
    EXCLUSIVE_REQUIRED: {
      icon: <GraduationCap size={32} />,
      title: 'Gold-exclusive course',
      body: 'Exclusive premium courses are included with the Gold plan.',
      cta: <Link to="/plans" className="btn primary"><Crown size={16} /> Upgrade to Gold</Link>,
    },
    EARLY_ACCESS: {
      icon: <Sparkles size={32} />,
      title: 'Early access for Gold members',
      body: `This new release is available to Gold members first${
        video.earlyAccessUntil ? `, and to everyone with a paid plan from ${formatDate(video.earlyAccessUntil)}` : ''
      }.`,
      cta: <Link to="/plans" className="btn primary"><Crown size={16} /> Upgrade to Gold</Link>,
    },
    DAILY_LIMIT: {
      icon: <Clock size={32} />,
      title: 'Daily watch limit reached',
      body: `Free accounts can watch up to ${dailyMinutes ?? 60} minutes a day. Your limit resets at midnight IST, or upgrade for unlimited watching.`,
      cta: <Link to="/plans" className="btn primary"><Crown size={16} /> Upgrade</Link>,
    },
  }[reason ?? 'PREMIUM_REQUIRED'];
  return (
    <div className="gate">
      <img className="gate-bg" src={video.thumbnailUrl} alt="" />
      <div className="gate-content">
        {copy.icon}
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        {copy.cta}
      </div>
    </div>
  );
}
