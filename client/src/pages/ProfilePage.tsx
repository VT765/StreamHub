import { Clock, Moon, Sun } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Avatar } from '../components/Avatar';
import { ProfileDownloads } from '../features/downloads/ProfileDownloads';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import type { User } from '../lib/types';
import './auth.css';

export function ProfilePage() {
  const { user, setUser, setTheme } = useAuth();
  const [form, setForm] = useState({ name: user!.name, phone: user!.phone ?? '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string; section: string } | null>(null);

  if (!user) return null;
  const themeMode = user.themeManuallySet ? user.theme : 'AUTO';

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    try {
      const { user } = await api.patch<{ user: User }>('/users/me', { name: form.name, phone: form.phone || null });
      setUser(user);
      setMsg({ kind: 'success', text: 'Profile saved', section: 'profile' });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err), section: 'profile' });
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    try {
      await api.put('/users/me/password', pw);
      setPw({ current: '', next: '' });
      setMsg({ kind: 'success', text: 'Password changed. Other sessions were signed out.', section: 'password' });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err), section: 'password' });
    }
  }

  const sectionMsg = (s: string) => msg?.section === s && <div className={`alert ${msg.kind}`}>{msg.text}</div>;

  return (
    <div className="container narrow stack">
      <div className="row">
        <Avatar name={user.name} src={user.avatarUrl} size={64} />
        <div>
          <h1 className="page-title">{user.name}</h1>
          <div className="muted">
            @{user.username} · {user.email} · Member since {formatDate(user.createdAt)}
          </div>
        </div>
      </div>

      <ProfileDownloads />

      <section className="card stack">
        <h2>Appearance</h2>
        <p className="muted" style={{ margin: 0 }}>
          Automatic uses your sign-in time: light between 5:00 AM and 12:00 PM IST, dark otherwise. A manual choice is saved to
          your profile and follows you to every device.
        </p>
        <div className="theme-options">
          {(
            [
              { value: 'AUTO', label: 'Automatic', icon: Clock },
              { value: 'LIGHT', label: 'Light', icon: Sun },
              { value: 'DARK', label: 'Dark', icon: Moon },
            ] as const
          ).map(({ value, label, icon: Icon }) => (
            <button key={value} className={`theme-option ${themeMode === value ? 'active' : ''}`} onClick={() => void setTheme(value)}>
              <Icon size={22} />
              {label}
            </button>
          ))}
        </div>
      </section>

      <form className="card stack" onSubmit={saveProfile}>
        <h2>Profile</h2>
        {sectionMsg('profile')}
        <div className="field">
          <label htmlFor="p-name">Full name</label>
          <input id="p-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="p-phone">Mobile number</label>
          <input id="p-phone" className="input" placeholder="+91XXXXXXXXXX" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <span className="subtle">Lets you receive sign-in codes by SMS.</span>
        </div>
        <div className="field">
          <label>Location (from your last sign-in)</label>
          <div className="muted">{[user.city, user.state, user.country].filter(Boolean).join(', ') || 'Unknown'}</div>
        </div>
        <div>
          <button className="btn primary">Save profile</button>
        </div>
      </form>

      <form className="card stack" onSubmit={changePassword}>
        <h2>Password</h2>
        {sectionMsg('password')}
        <div className="field">
          <label htmlFor="pw-cur">Current password</label>
          <input id="pw-cur" type="password" className="input" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
        </div>
        <div className="field">
          <label htmlFor="pw-new">New password</label>
          <input id="pw-new" type="password" className="input" minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
        </div>
        <div>
          <button className="btn">Change password</button>
        </div>
      </form>
    </div>
  );
}
