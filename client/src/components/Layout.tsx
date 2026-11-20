import {
  Crown,
  Download,
  Home,
  LogOut,
  Monitor,
  Moon,
  Shield,
  ShieldAlert,
  Sun,
  User as UserIcon,
  Video,
  CreditCard,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Avatar } from './Avatar';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/plans', label: 'Plans', icon: Crown },
  { to: '/meet', label: 'Meet', icon: Video },
  { to: '/downloads', label: 'Downloads', icon: Download },
];
/** Visitors only see the public pages; the rest need an account. */
const GUEST_NAV = NAV.filter((n) => n.to === '/' || n.to === '/plans');

export function Layout() {
  const { user, logout, setTheme } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const [waking, setWaking] = useState(false);
  useEffect(() => {
    const onWaking = (e: Event) => setWaking((e as CustomEvent<boolean>).detail);
    window.addEventListener('server:waking', onWaking);
    return () => window.removeEventListener('server:waking', onWaking);
  }, []);

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const isDark = document.documentElement.dataset.theme === 'dark';
  const nav = user ? NAV : GUEST_NAV;

  return (
    <>
      <header className="app-header">
        <Link to="/" className="logo">
          <span className="logo-mark">▶</span>
          StreamHub
        </Link>
        <nav className="nav">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end}>
              <Icon size={16} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        {user ? (
          <>
            <button
              className="btn ghost icon"
              title={`Switch to ${isDark ? 'light' : 'dark'} theme`}
              onClick={() => void setTheme(isDark ? 'LIGHT' : 'DARK')}
            >
              {isDark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="menu" ref={menuRef}>
              <button className="btn ghost icon" onClick={() => setOpen((o) => !o)} aria-label="Account menu">
                <Avatar name={user.name} src={user.avatarUrl} />
              </button>
              {open && (
                <div className="menu-panel">
                  <div style={{ padding: '8px 10px' }}>
                    <div style={{ fontWeight: 700 }}>{user.name}</div>
                    <div className="subtle">@{user.username}</div>
                  </div>
                  <div className="menu-sep" />
                  <Link to="/profile"><UserIcon size={16} /> Profile & preferences</Link>
                  <Link to="/subscription"><CreditCard size={16} /> Subscription</Link>
                  <Link to="/downloads"><Download size={16} /> Downloads</Link>
                  <Link to="/security"><Shield size={16} /> Account security</Link>
                  {user.role === 'ADMIN' && <Link to="/admin/moderation"><ShieldAlert size={16} /> Moderation</Link>}
                  <div className="menu-sep" />
                  <button onClick={() => void setTheme('AUTO')}>
                    <Monitor size={16} /> Theme: automatic {user.themeManuallySet ? '' : '✓'}
                  </button>
                  <button
                    onClick={async () => {
                      await logout();
                      navigate('/');
                    }}
                  >
                    <LogOut size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <Link to="/login" className="btn ghost">Sign in</Link>
            <Link to="/register" className="btn primary">
              <span className="hide-narrow">Create account</span>
              <span className="show-narrow">Sign up</span>
            </Link>
          </>
        )}
      </header>
      {waking && (
        <div className="wake-banner" role="status">
          <span className="spinner" /> Waking up the server — this can take up to a minute after a quiet period.
        </div>
      )}
      <main>
        <Outlet />
      </main>
      {user && (
      <nav className="mobile-nav">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}>
            <Icon size={20} /> {label}
          </NavLink>
        ))}
      </nav>
      )}
    </>
  );
}
