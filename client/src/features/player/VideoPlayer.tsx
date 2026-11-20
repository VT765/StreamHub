import {
  Captions,
  CaptionsOff,
  Gauge,
  Keyboard,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RectangleHorizontal,
  RotateCcw,
  RotateCw,
  Settings,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { formatDuration } from '../../lib/format';
import { claimPlayback, registerPlayer } from './playbackRegistry';
import { saveProgress } from './progressApi';
import type { VideoSummary } from './types';
import { useFramePreview } from './useFramePreview';
import './player.css';

export const SPEEDS = [0.5, 1, 1.25, 1.5, 2] as const;
const SEEK_STEP = 10;
const BIG_SEEK_STEP = 30;
const VOLUME_STEP = 0.05;
const HIDE_CONTROLS_MS = 3000;
const SAVE_EVERY_MS = 10_000;
const AUTOPLAY_COUNTDOWN = 5;

const PREFS_KEY = 'sh_player_prefs';
interface Prefs {
  volume: number;
  muted: boolean;
  rate: number;
  captions: boolean;
  autoplayNext: boolean;
}
function loadPrefs(): Prefs {
  const defaults: Prefs = { volume: 1, muted: false, rate: 1, captions: false, autoplayNext: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}
function storePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export interface VideoPlayerProps {
  video: Pick<VideoSummary, 'id' | 'title' | 'streamUrl' | 'captionsUrl' | 'durationSec'>;
  /** Resume position from the server. */
  startAt?: number;
  nextVideo?: Pick<VideoSummary, 'id' | 'title' | 'thumbnailUrl'> | null;
  onNext?: () => void;
  theater: boolean;
  onToggleTheater: () => void;
  /** Highest quality the user's plan allows, e.g. "720p". */
  planMaxQuality?: string;
  /** Plan includes priority (unthrottled) streaming. */
  fasterStreaming?: boolean;
  completePercent?: number;
  /** Signed-in users get progress saved. */
  trackProgress: boolean;
  /** Seconds of watch time left today (Free plan); null = unlimited. */
  remainingWatchSeconds?: number | null;
  onLimitReached?: () => void;
  onCompleted?: () => void;
  onPlaybackError?: () => void;
}

type Flash = { key: number; icon: 'play' | 'pause' | 'fwd' | 'back' | 'text'; text?: string };

function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function VideoPlayer({
  video,
  startAt = 0,
  nextVideo,
  onNext,
  theater,
  onToggleTheater,
  planMaxQuality,
  fasterStreaming,
  completePercent = 90,
  trackProgress,
  remainingWatchSeconds = null,
  onLimitReached,
  onCompleted,
  onPlaybackError,
}: VideoPlayerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(video.durationSec || 0);
  const [buffered, setBuffered] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pip, setPip] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [menu, setMenu] = useState<null | 'settings' | 'speed'>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [quality, setQuality] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);

  const preview = useFramePreview(video.streamUrl);

  // ── Refs for progress tracking (avoid re-renders) ──
  const watchedAccum = useRef(0);
  const lastTick = useRef<number | null>(null);
  const remaining = useRef<number | null>(remainingWatchSeconds);
  const completedSent = useRef(false);
  const hideTimer = useRef<number>();
  const clickTimer = useRef<number>();

  useEffect(() => {
    remaining.current = remainingWatchSeconds;
  }, [remainingWatchSeconds]);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      storePrefs(next);
      return next;
    });
  }, []);

  const showFlash = useCallback((f: Omit<Flash, 'key'>) => setFlash({ ...f, key: Date.now() }), []);

  // ── Apply preferences to the element ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = prefs.volume;
    v.muted = prefs.muted;
    v.playbackRate = prefs.rate;
  }, [prefs.volume, prefs.muted, prefs.rate]);

  useEffect(() => {
    const track = videoRef.current?.textTracks[0];
    if (track) track.mode = prefs.captions ? 'showing' : 'hidden';
  }, [prefs.captions, video.captionsUrl]);

  // ── Register for single-playback enforcement ──
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    return registerPlayer(v);
  }, []);

  // ── Progress saving ──
  // Latest position/duration are mirrored into refs so a save on unmount or video switch
  // still reports the outgoing video's position.
  const posRef = useRef(0);
  const durRef = useRef(0);
  const cbRef = useRef({ trackProgress, onCompleted, onLimitReached });
  cbRef.current = { trackProgress, onCompleted, onLimitReached };

  const flushFor = useCallback(async (videoId: string, keepalive = false) => {
    const { trackProgress, onCompleted, onLimitReached } = cbRef.current;
    if (!trackProgress || !durRef.current) return;
    const delta = Math.min(30, watchedAccum.current);
    watchedAccum.current -= delta;
    const res = await saveProgress(
      videoId,
      { positionSec: posRef.current, durationSec: durRef.current, watchedDeltaSec: delta },
      keepalive,
    );
    if (!res) return;
    if (res.justCompleted) onCompleted?.();
    remaining.current = res.remainingWatchSeconds;
    if (res.limitReached) {
      videoRef.current?.pause();
      onLimitReached?.();
    }
  }, []);
  const flush = useCallback((keepalive = false) => flushFor(video.id, keepalive), [flushFor, video.id]);

  useEffect(() => {
    if (!playing || !trackProgress) return;
    const id = window.setInterval(() => void flush(), SAVE_EVERY_MS);
    return () => window.clearInterval(id);
  }, [playing, trackProgress, flush]);

  useEffect(() => {
    const videoId = video.id;
    const onHide = () => void flushFor(videoId, true);
    const onVisibility = () => document.visibilityState === 'hidden' && onHide();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      onHide(); // unmount or switching to another video
    };
  }, [flushFor, video.id]);

  // Reset per-video state when the source changes.
  useEffect(() => {
    watchedAccum.current = 0;
    posRef.current = 0;
    durRef.current = 0;
    lastTick.current = null;
    completedSent.current = false;
    setCountdown(null);
    setError(null);
    setLoading(true);
    setCurrent(0);
    setBuffered(0);
    setResumedFrom(null);
    setDuration(video.durationSec || 0);
  }, [video.id, video.durationSec]);

  // ── Media element events ──
  const onLoadedMetadata = () => {
    const v = videoRef.current!;
    setDuration(v.duration);
    durRef.current = v.duration;
    setQuality(v.videoHeight ? `${v.videoHeight}p` : null);
    // Resume unless they'd basically finished it.
    if (startAt > 5 && startAt < v.duration * (completePercent / 100)) {
      v.currentTime = startAt;
      setResumedFrom(startAt);
      window.setTimeout(() => setResumedFrom(null), 4000);
    }
    const track = v.textTracks[0];
    if (track) track.mode = prefs.captions ? 'showing' : 'hidden';
  };

  const onTimeUpdate = () => {
    const v = videoRef.current!;
    setCurrent(v.currentTime);
    posRef.current = v.currentTime;
    // Count real watched time: small forward steps while playing (not seeks).
    const now = v.currentTime;
    if (lastTick.current !== null && !v.paused && !v.seeking) {
      const step = (now - lastTick.current) / (v.playbackRate || 1);
      if (step > 0 && step < 2) {
        watchedAccum.current += step;
        if (remaining.current !== null) {
          remaining.current -= step;
          if (remaining.current <= 0) {
            v.pause();
            void flush();
            onLimitReached?.();
          }
        }
      }
    }
    lastTick.current = now;
    if (!completedSent.current && v.duration && (now / v.duration) * 100 >= completePercent) {
      completedSent.current = true;
      void flush();
    }
  };

  const onProgress = () => {
    const v = videoRef.current!;
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) return setBuffered(b.end(i));
    }
    if (b.length) setBuffered(b.end(b.length - 1));
  };

  const onPlay = () => {
    claimPlayback(videoRef.current!);
    setPlaying(true);
    setCountdown(null);
    lastTick.current = videoRef.current!.currentTime;
  };

  const onPause = () => {
    setPlaying(false);
    setControlsVisible(true);
    lastTick.current = null;
    void flush();
  };

  const onEnded = () => {
    setPlaying(false);
    setControlsVisible(true);
    void flush();
    if (nextVideo && prefs.autoplayNext) setCountdown(AUTOPLAY_COUNTDOWN);
  };

  const onError = () => {
    setLoading(false);
    setError('This video could not be played. You may have reached your limit or lost access.');
    onPlaybackError?.();
  };

  // ── Autoplay-next countdown ──
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      onNext?.();
      return;
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown, onNext]);

  // ── Actions ──
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || error) return;
    if (v.paused || v.ended) {
      void v.play().catch(() => {});
      showFlash({ icon: 'play' });
    } else {
      v.pause();
      showFlash({ icon: 'pause' });
    }
  }, [error, showFlash]);

  const seekBy = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
      setCurrent(v.currentTime);
      showFlash({ icon: delta > 0 ? 'fwd' : 'back', text: `${Math.abs(delta)}s` });
    },
    [showFlash],
  );

  const seekTo = useCallback((time: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, time));
    setCurrent(v.currentTime);
  }, []);

  const setVolume = useCallback(
    (vol: number, flashIt = false) => {
      const volume = Math.round(Math.max(0, Math.min(1, vol)) * 100) / 100;
      updatePrefs({ volume, muted: volume === 0 });
      if (flashIt) showFlash({ icon: 'text', text: `Volume ${Math.round(volume * 100)}%` });
    },
    [updatePrefs, showFlash],
  );

  const toggleMute = useCallback(() => {
    const muted = !prefs.muted;
    updatePrefs({ muted, volume: !muted ? prefs.volume : prefs.volume || 0.5 });
    showFlash({ icon: 'text', text: muted ? 'Muted' : 'Unmuted' });
  }, [prefs.muted, prefs.volume, updatePrefs, showFlash]);

  const setRate = useCallback(
    (rate: number) => {
      updatePrefs({ rate });
      showFlash({ icon: 'text', text: `${rate}×` });
    },
    [updatePrefs, showFlash],
  );

  const stepRate = useCallback(
    (dir: 1 | -1) => {
      const i = SPEEDS.indexOf(prefs.rate as (typeof SPEEDS)[number]);
      const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i === -1 ? 1 : i) + dir))];
      setRate(next);
    },
    [prefs.rate, setRate],
  );

  const toggleCaptions = useCallback(() => {
    if (!video.captionsUrl) return showFlash({ icon: 'text', text: 'No captions available' });
    updatePrefs({ captions: !prefs.captions });
    showFlash({ icon: 'text', text: prefs.captions ? 'Captions off' : 'Captions on' });
  }, [video.captionsUrl, prefs.captions, updatePrefs, showFlash]);

  const toggleFullscreen = useCallback(() => {
    const wrap = wrapRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) return void document.exitFullscreen();
    if (wrap?.requestFullscreen) return void wrap.requestFullscreen().catch(() => {});
    if (wrap?.webkitRequestFullscreen) return wrap.webkitRequestFullscreen();
    v?.webkitEnterFullscreen?.(); // iOS Safari
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else showFlash({ icon: 'text', text: 'Picture-in-Picture not supported' });
    } catch {
      showFlash({ icon: 'text', text: 'Picture-in-Picture unavailable' });
    }
  }, [showFlash]);

  const goNext = useCallback(() => {
    if (nextVideo) {
      setCountdown(null);
      onNext?.();
    }
  }, [nextVideo, onNext]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    const v = videoRef.current;
    const onEnterPip = () => setPip(true);
    const onLeavePip = () => setPip(false);
    v?.addEventListener('enterpictureinpicture', onEnterPip);
    v?.addEventListener('leavepictureinpicture', onLeavePip);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      v?.removeEventListener('enterpictureinpicture', onEnterPip);
      v?.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, []);

  // ── Controls auto-hide ──
  const poke = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), HIDE_CONTROLS_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  const keepControls = !playing || menu !== null || scrubbing || showShortcuts || countdown !== null;
  const controlsShown = controlsVisible || keepControls;

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      let handled = true;
      switch (key) {
        case ' ':
        case 'k':
        case 'K':
          togglePlay();
          break;
        case 'ArrowLeft':
          seekBy(e.shiftKey ? -BIG_SEEK_STEP : -SEEK_STEP);
          break;
        case 'ArrowRight':
          seekBy(e.shiftKey ? BIG_SEEK_STEP : SEEK_STEP);
          break;
        case 'j':
        case 'J':
          seekBy(-SEEK_STEP);
          break;
        case 'l':
        case 'L':
          seekBy(SEEK_STEP);
          break;
        case 'ArrowUp':
          setVolume((prefs.muted ? 0 : prefs.volume) + VOLUME_STEP, true);
          break;
        case 'ArrowDown':
          setVolume((prefs.muted ? 0 : prefs.volume) - VOLUME_STEP, true);
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case '>':
        case '.':
          stepRate(1);
          break;
        case '<':
        case ',':
          stepRate(-1);
          break;
        case 'p':
        case 'P':
          void togglePip();
          break;
        case 't':
        case 'T':
          onToggleTheater();
          break;
        case 'c':
        case 'C':
          toggleCaptions();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'n':
        case 'N':
          goNext();
          break;
        case '?':
          setShowShortcuts((s) => !s);
          break;
        case 'Escape':
          if (showShortcuts || menu) {
            setShowShortcuts(false);
            setMenu(null);
          } else handled = false;
          break;
        case 'Home':
          seekTo(0);
          break;
        case 'End':
          seekTo(duration);
          break;
        default:
          if (/^[0-9]$/.test(key)) seekTo((Number(key) / 10) * duration);
          else handled = false;
      }
      if (handled) {
        e.preventDefault();
        poke();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    togglePlay, seekBy, setVolume, toggleMute, stepRate, togglePip, onToggleTheater, toggleCaptions,
    toggleFullscreen, goNext, seekTo, poke, prefs.muted, prefs.volume, duration, showShortcuts, menu,
  ]);

  // ── Mouse on the video surface: single click = play/pause, double click = fullscreen ──
  const onSurfaceClick = (e: React.MouseEvent) => {
    if (e.detail > 1) return;
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(() => {
      if (menu) return setMenu(null);
      togglePlay();
    }, 200);
  };
  const onSurfaceDoubleClick = () => {
    window.clearTimeout(clickTimer.current);
    toggleFullscreen();
  };

  // Touch: tap toggles controls; double-tap on left/right third seeks.
  const lastTap = useRef<{ t: number; x: number } | null>(null);
  const onSurfaceTouch = (e: React.TouchEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.changedTouches[0].clientX - rect.left;
    const now = Date.now();
    e.preventDefault();
    if (lastTap.current && now - lastTap.current.t < 300) {
      if (x < rect.width / 3) seekBy(-SEEK_STEP);
      else if (x > (rect.width * 2) / 3) seekBy(SEEK_STEP);
      else toggleFullscreen();
      lastTap.current = null;
      return;
    }
    lastTap.current = { t: now, x };
    if (controlsShown && playing) setControlsVisible(false);
    else poke();
  };

  // ── Timeline scrubbing & hover preview ──
  const timeAt = (clientX: number) => {
    const rect = timelineRef.current!.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return { time: ratio * (duration || 0), x: ratio * rect.width };
  };
  const onTimelineMove = (e: ReactPointerEvent) => {
    const { time, x } = timeAt(e.clientX);
    setHover({ time, x });
    preview.request(time);
    if (scrubbing) seekTo(time);
  };
  const onTimelineDown = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setScrubbing(true);
    seekTo(timeAt(e.clientX).time);
  };
  const onTimelineUp = (e: ReactPointerEvent) => {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setScrubbing(false);
    if (e.pointerType !== 'mouse') setHover(null);
  };

  // ── Volume dragging ──
  const [volDragging, setVolDragging] = useState(false);
  const volAt = (clientX: number) => {
    const rect = volumeRef.current!.getBoundingClientRect();
    return (clientX - rect.left) / rect.width;
  };
  const onVolumeWheel = (e: React.WheelEvent) => {
    setVolume((prefs.muted ? 0 : prefs.volume) + (e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP));
  };
  useEffect(() => {
    // Wheel listeners must be non-passive to stop page scroll.
    const el = volumeRef.current?.parentElement;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  const effectiveVolume = prefs.muted ? 0 : prefs.volume;
  const VolumeIcon = effectiveVolume === 0 ? VolumeX : effectiveVolume < 0.5 ? Volume1 : Volume2;
  const pct = (n: number) => (duration ? `${Math.min(100, (n / duration) * 100)}%` : '0%');
  const hoverFrame = hover && preview.frame && preview.frame.bucket === Math.round(hover.time / preview.bucketSec) ? preview.frame.url : null;

  return (
    <div
      ref={wrapRef}
      className={`vp ${controlsShown ? '' : 'vp-idle'} ${theater ? 'vp-theater' : ''} ${fullscreen ? 'vp-fullscreen' : ''}`}
      onMouseMove={poke}
      onMouseLeave={() => playing && setControlsVisible(false)}
      tabIndex={-1}
    >
      <video
        ref={videoRef}
        className="vp-video"
        src={video.streamUrl}
        preload="metadata"
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onProgress={onProgress}
        onPlay={onPlay}
        onPause={onPause}
        onEnded={onEnded}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onPlaying={() => setLoading(false)}
        onSeeking={() => setLoading(true)}
        onSeeked={() => setLoading(false)}
        onError={onError}
        onRateChange={() => videoRef.current && videoRef.current.playbackRate !== prefs.rate && updatePrefs({ rate: videoRef.current.playbackRate })}
      >
        {video.captionsUrl && <track kind="subtitles" src={video.captionsUrl} srcLang="en" label="English" />}
      </video>

      {/* Click/touch surface (above video, below controls) */}
      <div
        className="vp-surface"
        onClick={onSurfaceClick}
        onDoubleClick={onSurfaceDoubleClick}
        onTouchEnd={onSurfaceTouch}
      />

      {loading && !error && (
        <div className="vp-center">
          <div className="vp-spinner" />
        </div>
      )}

      {!playing && !loading && !error && countdown === null && (
        <button className="vp-big-play" onClick={togglePlay} aria-label="Play">
          <Play size={34} fill="currentColor" />
        </button>
      )}

      {flash && (
        <div key={flash.key} className="vp-flash">
          {flash.icon === 'play' && <Play size={28} fill="currentColor" />}
          {flash.icon === 'pause' && <Pause size={28} fill="currentColor" />}
          {flash.icon === 'fwd' && (<><RotateCw size={24} /> <span>{flash.text}</span></>)}
          {flash.icon === 'back' && (<><RotateCcw size={24} /> <span>{flash.text}</span></>)}
          {flash.icon === 'text' && <span>{flash.text}</span>}
        </div>
      )}

      {resumedFrom !== null && (
        <div className="vp-toast">
          Resumed from {formatDuration(resumedFrom)}
          <button className="vp-link" onClick={() => { seekTo(0); setResumedFrom(null); }}>Start over</button>
        </div>
      )}

      {error && (
        <div className="vp-center vp-error">
          <p>{error}</p>
        </div>
      )}

      {countdown !== null && nextVideo && (
        <div className="vp-next-overlay">
          <div className="vp-next-card">
            <div className="vp-next-label">Up next in {countdown}</div>
            <img src={nextVideo.thumbnailUrl} alt="" />
            <div className="vp-next-title">{nextVideo.title}</div>
            <div className="vp-next-ring" style={{ ['--p' as string]: `${((AUTOPLAY_COUNTDOWN - countdown) / AUTOPLAY_COUNTDOWN) * 100}%` }} />
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn sm" onClick={() => setCountdown(null)}>Cancel</button>
              <button className="btn sm primary" onClick={goNext}>
                <SkipForward size={14} /> Play now
              </button>
            </div>
          </div>
        </div>
      )}

      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}

      {/* ── Control bar ── */}
      <div className="vp-controls" onClick={(e) => e.stopPropagation()}>
        <div
          ref={timelineRef}
          className={`vp-timeline ${scrubbing ? 'scrubbing' : ''}`}
          onPointerMove={onTimelineMove}
          onPointerDown={onTimelineDown}
          onPointerUp={onTimelineUp}
          onPointerLeave={() => !scrubbing && setHover(null)}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          aria-valuetext={`${formatDuration(current)} of ${formatDuration(duration)}`}
        >
          <div className="vp-track">
            <div className="vp-buffered" style={{ width: pct(buffered) }} />
            {hover && <div className="vp-hovered" style={{ width: pct(hover.time) }} />}
            <div className="vp-played" style={{ width: pct(current) }} />
            <div className="vp-thumb" style={{ left: pct(current) }} />
          </div>
          {hover && (
            <div
              className="vp-preview"
              style={{
                left: `clamp(${preview.width / 2}px, ${hover.x}px, calc(100% - ${preview.width / 2}px))`,
              }}
            >
              <div className="vp-preview-frame" style={{ width: preview.width, height: preview.height }}>
                {hoverFrame ? <img src={hoverFrame} alt="" /> : <div className="vp-preview-blank" />}
              </div>
              <span>{formatDuration(hover.time)}</span>
            </div>
          )}
        </div>

        <div className="vp-bar">
          <button className="vp-btn" onClick={togglePlay} title={playing ? 'Pause (k)' : 'Play (k)'}>
            {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>
          <button className="vp-btn hide-xs" onClick={() => seekBy(-SEEK_STEP)} title="Back 10s (←)">
            <RotateCcw size={18} />
          </button>
          <button className="vp-btn hide-xs" onClick={() => seekBy(SEEK_STEP)} title="Forward 10s (→)">
            <RotateCw size={18} />
          </button>
          {nextVideo && (
            <button className="vp-btn" onClick={goNext} title="Next (n)">
              <SkipForward size={18} />
            </button>
          )}

          <div className="vp-volume" onWheel={onVolumeWheel}>
            <button className="vp-btn" onClick={toggleMute} title={prefs.muted ? 'Unmute (m)' : 'Mute (m)'}>
              <VolumeIcon size={20} />
            </button>
            <div
              ref={volumeRef}
              className={`vp-volume-slider ${volDragging ? 'dragging' : ''}`}
              role="slider"
              aria-label="Volume"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(effectiveVolume * 100)}
              onPointerDown={(e) => {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setVolDragging(true);
                setVolume(volAt(e.clientX));
              }}
              onPointerMove={(e) => volDragging && setVolume(volAt(e.clientX))}
              onPointerUp={(e) => {
                (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                setVolDragging(false);
              }}
            >
              <div className="vp-volume-track">
                <div className="vp-volume-fill" style={{ width: `${effectiveVolume * 100}%` }} />
                <div className="vp-volume-knob" style={{ left: `${effectiveVolume * 100}%` }} />
              </div>
            </div>
          </div>

          <div className="vp-time">
            <span>{formatDuration(current)}</span>
            <span className="vp-time-sep"> / </span>
            <span>{formatDuration(duration)}</span>
            <span className="vp-remaining hide-xs">−{formatDuration(Math.max(0, duration - current))}</span>
          </div>

          <div className="spacer" />

          {quality && <span className="vp-quality hide-xs" title="Current stream quality">{quality}</span>}

          <button className="vp-btn" onClick={toggleCaptions} title="Subtitles (c)" disabled={!video.captionsUrl}>
            {prefs.captions && video.captionsUrl ? <Captions size={20} /> : <CaptionsOff size={20} />}
          </button>

          <div className="vp-menu-wrap">
            <button
              className={`vp-btn ${menu ? 'active' : ''}`}
              onClick={() => setMenu(menu ? null : 'settings')}
              title="Settings"
            >
              <Settings size={20} />
            </button>
            {menu === 'settings' && (
              <div className="vp-menu">
                <button className="vp-menu-item" onClick={() => setMenu('speed')}>
                  <Gauge size={16} /> Playback speed <span className="spacer" /> <b>{prefs.rate === 1 ? 'Normal' : `${prefs.rate}×`}</b>
                </button>
                <div className="vp-menu-item static">
                  Quality <span className="spacer" />
                  <b>{quality ?? '—'}</b>
                </div>
                {planMaxQuality && (
                  <div className="vp-menu-item static subtle-row">
                    Plan maximum <span className="spacer" /> {planMaxQuality}
                  </div>
                )}
                {fasterStreaming !== undefined && (
                  <div className="vp-menu-item static subtle-row">
                    Streaming <span className="spacer" /> {fasterStreaming ? 'Priority (faster)' : 'Standard'}
                  </div>
                )}
                <label className="vp-menu-item">
                  Autoplay next <span className="spacer" />
                  <input
                    type="checkbox"
                    checked={prefs.autoplayNext}
                    onChange={(e) => updatePrefs({ autoplayNext: e.target.checked })}
                  />
                </label>
                <button className="vp-menu-item" onClick={() => { setMenu(null); setShowShortcuts(true); }}>
                  <Keyboard size={16} /> Keyboard shortcuts <span className="spacer" /> <kbd>?</kbd>
                </button>
              </div>
            )}
            {menu === 'speed' && (
              <div className="vp-menu">
                <button className="vp-menu-item" onClick={() => setMenu('settings')}>‹ Playback speed</button>
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    className={`vp-menu-item ${prefs.rate === s ? 'selected' : ''}`}
                    onClick={() => { setRate(s); setMenu(null); }}
                  >
                    {s === 1 ? 'Normal' : `${s}×`}
                    {prefs.rate === s && <span className="spacer" />}
                    {prefs.rate === s && '✓'}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="vp-btn hide-xs" onClick={() => void togglePip()} title="Picture-in-picture (p)">
            <PictureInPicture2 size={20} className={pip ? 'on' : ''} />
          </button>
          <button className="vp-btn hide-sm" onClick={onToggleTheater} title="Theater mode (t)">
            <RectangleHorizontal size={20} className={theater ? 'on' : ''} />
          </button>
          <button className="vp-btn" onClick={toggleFullscreen} title="Full screen (f)">
            {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space / K', 'Play / pause'],
  ['← / →', 'Seek 10 seconds'],
  ['Shift + ← / →', 'Seek 30 seconds'],
  ['J / L', 'Back / forward 10 seconds'],
  ['↑ / ↓', 'Volume up / down'],
  ['M', 'Mute / unmute'],
  ['> / <', 'Faster / slower'],
  ['0 – 9', 'Jump to 0% – 90%'],
  ['C', 'Subtitles on / off'],
  ['P', 'Picture-in-picture'],
  ['T', 'Theater mode'],
  ['F', 'Full screen'],
  ['N', 'Next video'],
  ['?', 'Show this help'],
];

function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="vp-shortcuts" onClick={onClose}>
      <div className="vp-shortcuts-card" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3>Keyboard shortcuts</h3>
          <span className="spacer" />
          <button className="vp-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <dl>
          {SHORTCUTS.map(([k, d]) => (
            <div key={k}>
              <dt><kbd>{k}</kbd></dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
        <p className="vp-shortcuts-foot">Click the video to play/pause · double-click for full screen · scroll over the volume to adjust</p>
      </div>
    </div>
  );
}
