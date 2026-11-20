import {
  ArrowRight,
  Check,
  Crown,
  Download,
  Languages,
  Play,
  ShieldCheck,
  Sparkles,
  Video,
  MonitorPlay,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatINR } from '../lib/format';
import './landing.css';

interface ThumbVideo {
  id: string;
  title: string;
  thumbnailUrl: string;
  isPremium: boolean;
  isExclusive: boolean;
}

interface PublicPlan {
  tier: 'FREE' | 'BRONZE' | 'SILVER' | 'GOLD';
  name: string;
  tagline: string;
  prices: { MONTHLY: number };
  downloadsPerDay: number;
  maxQuality: string;
}

const FEATURES = [
  {
    icon: MonitorPlay,
    title: 'A player built for learning',
    body: 'Keyboard shortcuts, speed control, captions, theater and picture-in-picture. Pick up exactly where you left off.',
  },
  {
    icon: Video,
    title: 'Secure video calls',
    body: 'One-to-one or group calls from a single link, with screen sharing, chat, raised hands and host controls.',
  },
  {
    icon: Download,
    title: 'Watch offline',
    body: 'Download videos to watch without a connection, with fair daily limits that grow with your plan.',
  },
  {
    icon: Languages,
    title: 'Comments in any language',
    body: 'Discuss every video and translate any comment instantly. Spam and abuse are filtered automatically.',
  },
  {
    icon: Crown,
    title: 'Plans that grow with you',
    body: 'Start free. Upgrade for premium videos, up to 4K quality, ad-free viewing and Gold-only courses.',
  },
  {
    icon: ShieldCheck,
    title: 'Your account, protected',
    body: 'New devices are verified with a one-time code, and you can review every sign-in from your security page.',
  },
];

const STEPS = [
  { title: 'Create a free account', body: 'Sign up in under a minute — no card needed.' },
  { title: 'Start watching', body: 'Browse the catalog and stream free videos right away.' },
  { title: 'Upgrade any time', body: 'Unlock premium content, more downloads and higher quality.' },
];

/** Public home page for signed-out visitors: what StreamHub is, with the way in. */
export function LandingPage() {
  const [videos, setVideos] = useState<ThumbVideo[]>([]);
  const [plans, setPlans] = useState<PublicPlan[]>([]);

  useEffect(() => {
    api.get<{ items: ThumbVideo[] }>('/videos').then((r) => setVideos(r.items.slice(0, 4))).catch(() => {});
    api.get<{ plans: PublicPlan[] }>('/subscriptions/plans').then((r) => setPlans(r.plans)).catch(() => {});
  }, []);

  return (
    <div className="landing">
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <span className="badge accent lp-eyebrow">
            <Sparkles size={13} /> Stream · Learn · Meet
          </span>
          <h1 className="lp-title">
            Videos, courses and live calls — <span className="lp-accent">all in one place.</span>
          </h1>
          <p className="lp-lead">
            StreamHub is a streaming platform with a custom player, offline downloads, multilingual discussions and
            secure video calling. Start free and upgrade when you want more.
          </p>
          <div className="lp-cta">
            <Link to="/register" className="btn primary lg">
              Create free account <ArrowRight size={18} />
            </Link>
            <Link to="/login" className="btn lg">
              Sign in
            </Link>
          </div>
          <ul className="lp-points">
            <li><Check size={15} /> Free plan, no card needed</li>
            <li><Check size={15} /> Works on phone, tablet and desktop</li>
          </ul>
        </div>

        <div className="lp-hero-visual" aria-hidden="true">
          <div className="lp-screen">
            <div className="lp-screen-media">
              {videos[0] ? <img src={videos[0].thumbnailUrl} alt="" /> : <div className="lp-shimmer" />}
              <span className="lp-play"><Play size={26} fill="currentColor" /></span>
            </div>
            <div className="lp-screen-bar">
              <div className="lp-progress"><span /></div>
              <div className="lp-screen-meta">
                <strong>{videos[0]?.title ?? 'Now playing'}</strong>
                <span>1.5× · CC · HD</span>
              </div>
            </div>
          </div>
          <div className="lp-thumbs">
            {(videos.length ? videos.slice(1, 4) : [null, null, null]).map((v, i) => (
              <div key={v?.id ?? i} className="lp-thumb">
                {v ? <img src={v.thumbnailUrl} alt="" /> : <div className="lp-shimmer" />}
                {v && (v.isExclusive || v.isPremium) && (
                  <span className="badge plan-GOLD lp-thumb-badge">
                    <Crown size={11} /> {v.isExclusive ? 'Gold' : 'Premium'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <h2>Everything you need to watch, learn and connect</h2>
          <p className="muted">One account gives you the whole platform.</p>
        </div>
        <div className="lp-features">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="lp-feature card">
              <span className="lp-feature-icon"><Icon size={20} /></span>
              <h3>{title}</h3>
              <p className="muted">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-section-head">
          <h2>Get started in three steps</h2>
        </div>
        <ol className="lp-steps">
          {STEPS.map((s, i) => (
            <li key={s.title} className="card">
              <span className="lp-step-num">{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p className="muted">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {plans.length > 0 && (
        <section className="lp-section">
          <div className="lp-section-head">
            <h2>Simple plans</h2>
            <p className="muted">Monthly prices. Quarterly and yearly billing save more.</p>
          </div>
          <div className="lp-plans">
            {plans.map((p) => (
              <div key={p.tier} className={`lp-plan card ${p.tier === 'GOLD' ? 'featured' : ''}`}>
                <span className={`badge plan-${p.tier}`}>{p.name}</span>
                <div className="lp-plan-price">
                  {p.prices.MONTHLY === 0 ? 'Free' : formatINR(p.prices.MONTHLY)}
                  {p.prices.MONTHLY > 0 && <span>/mo</span>}
                </div>
                <p className="muted">{p.tagline}</p>
                <div className="subtle">
                  Up to {p.maxQuality} · {p.downloadsPerDay} download{p.downloadsPerDay === 1 ? '' : 's'}/day
                </div>
              </div>
            ))}
          </div>
          <div className="lp-center">
            <Link to="/plans" className="btn">Compare all features <ArrowRight size={16} /></Link>
          </div>
        </section>
      )}

      <section className="lp-final card">
        <h2>Ready to start watching?</h2>
        <p className="muted">Create your free account and explore the full catalog today.</p>
        <div className="lp-cta center">
          <Link to="/register" className="btn primary lg">
            Create free account <ArrowRight size={18} />
          </Link>
          <Link to="/login" className="btn lg">
            I already have an account
          </Link>
        </div>
      </section>

      <footer className="lp-footer subtle">
        <span className="logo-mark sm">▶</span> StreamHub · Payments are in Razorpay test mode
      </footer>
    </div>
  );
}
