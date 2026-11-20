import { Laptop, LogOut, MapPin, Monitor, Smartphone, Tablet, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, timeAgo } from '../lib/format';
import './auth.css';

interface LoginEvent {
  id: string;
  status: string;
  reasons: string[];
  ip: string | null;
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  osVersion: string | null;
  deviceType: string | null;
  deviceModel: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  createdAt: string;
}

interface Device {
  id: string;
  label: string;
  deviceType: string | null;
  lastIp: string | null;
  lastCity: string | null;
  lastState: string | null;
  trustedUntil: string;
  lastUsedAt: string;
  createdAt: string;
  isCurrent: boolean;
  expired: boolean;
}

interface Session {
  id: string;
  ip: string | null;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  city: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  SUCCESS: { label: 'Signed in', tone: 'success' },
  OTP_VERIFIED: { label: 'Verified with code', tone: 'success' },
  OTP_REQUIRED: { label: 'Code requested', tone: 'info' },
  OTP_FAILED: { label: 'Wrong code', tone: 'danger' },
  FAILED_PASSWORD: { label: 'Wrong password', tone: 'danger' },
  BLOCKED: { label: 'Blocked', tone: 'danger' },
};

const REASON: Record<string, string> = {
  NEW_BROWSER: 'new browser',
  NEW_DEVICE: 'new device',
  NEW_IP: 'new IP',
  NEW_LOCATION: 'new location',
};

function DeviceIcon({ type }: { type: string | null }) {
  if (type === 'Mobile') return <Smartphone size={20} />;
  if (type === 'Tablet') return <Tablet size={20} />;
  return <Laptop size={20} />;
}

const place = (...parts: (string | null)[]) => parts.filter(Boolean).join(', ') || 'Unknown location';

export function SecurityPage() {
  const [tab, setTab] = useState<'history' | 'devices' | 'sessions'>('history');
  const [logins, setLogins] = useState<{ items: LoginEvent[]; total: number; page: number }>({ items: [], total: 0, page: 1 });
  const [devices, setDevices] = useState<Device[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [error, setError] = useState('');

  const loadLogins = useCallback(async (page: number) => {
    setLogins(await api.get(`/security/logins?page=${page}`));
  }, []);
  const loadDevices = useCallback(async () => setDevices((await api.get<{ items: Device[] }>('/security/devices')).items), []);
  const loadSessions = useCallback(async () => setSessions((await api.get<{ items: Session[] }>('/security/sessions')).items), []);

  useEffect(() => {
    Promise.all([
      loadLogins(1),
      loadDevices(),
      loadSessions(),
      api.get<{ last30Days: Record<string, number> }>('/security/summary').then((s) => setSummary(s.last30Days)),
    ]).catch((e) => setError(errorMessage(e)));
  }, [loadLogins, loadDevices, loadSessions]);

  async function act(fn: () => Promise<unknown>, reload: () => Promise<void>) {
    setError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const failed = (summary.FAILED_PASSWORD ?? 0) + (summary.OTP_FAILED ?? 0);
  const pages = Math.max(1, Math.ceil(logins.total / 20));

  return (
    <div className="container stack">
      <div>
        <h1 className="page-title">Account security</h1>
        <p className="page-subtitle">
          Review where your account is signed in. Sign-ins from a new browser, device, IP address or city/state need a verification code.
        </p>
      </div>
      {error && <div className="alert error">{error}</div>}

      <div className="grid security-stats">
        <div className="card"><div className="subtle">Sign-ins (30 days)</div><div style={{ fontSize: 26, fontWeight: 700 }}>{(summary.SUCCESS ?? 0) + (summary.OTP_VERIFIED ?? 0)}</div></div>
        <div className="card"><div className="subtle">Failed attempts (30 days)</div><div style={{ fontSize: 26, fontWeight: 700, color: failed ? 'var(--danger)' : undefined }}>{failed}</div></div>
        <div className="card"><div className="subtle">Trusted devices</div><div style={{ fontSize: 26, fontWeight: 700 }}>{devices.length}</div></div>
        <div className="card"><div className="subtle">Active sessions</div><div style={{ fontSize: 26, fontWeight: 700 }}>{sessions.length}</div></div>
      </div>

      <div className="card">
        <div className="tabs">
          <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>Login history</button>
          <button className={`tab ${tab === 'devices' ? 'active' : ''}`} onClick={() => setTab('devices')}>Trusted devices</button>
          <button className={`tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>Active sessions</button>
        </div>

        {tab === 'history' && (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>When</th><th>Result</th><th>Browser</th><th>Device</th><th>IP address</th><th>Location</th></tr>
                </thead>
                <tbody>
                  {logins.items.map((l) => {
                    const s = STATUS[l.status] ?? { label: l.status, tone: '' };
                    return (
                      <tr key={l.id}>
                        <td title={formatDateTime(l.createdAt)}>{formatDateTime(l.createdAt)}</td>
                        <td>
                          <span className={`badge ${s.tone}`}>{s.label}</span>
                          {l.reasons.length > 0 && <div className="subtle">{l.reasons.map((r) => REASON[r] ?? r).join(', ')}</div>}
                        </td>
                        <td>{l.browser ?? 'Unknown'} {l.browserVersion?.split('.')[0]}<div className="subtle">{l.os} {l.osVersion}</div></td>
                        <td>{l.deviceType}{l.deviceModel && <div className="subtle">{l.deviceModel}</div>}</td>
                        <td><code>{l.ip ?? '—'}</code></td>
                        <td>{place(l.city, l.state, l.country)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {logins.items.length === 0 && <div className="empty">No sign-ins yet.</div>}
            {pages > 1 && (
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn sm" disabled={logins.page <= 1} onClick={() => void loadLogins(logins.page - 1)}>Previous</button>
                <span className="subtle">Page {logins.page} of {pages}</span>
                <button className="btn sm" disabled={logins.page >= pages} onClick={() => void loadLogins(logins.page + 1)}>Next</button>
              </div>
            )}
          </>
        )}

        {tab === 'devices' && (
          <div>
            {devices.length === 0 && <div className="empty">No trusted devices. You’ll be asked for a code on every new sign-in.</div>}
            {devices.map((d) => (
              <div className="security-item" key={d.id}>
                <span className="security-icon"><DeviceIcon type={d.deviceType} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {d.label} {d.isCurrent && <span className="badge accent">This device</span>} {d.expired && <span className="badge warning">Trust expired</span>}
                  </div>
                  <div className="subtle">
                    <MapPin size={12} style={{ verticalAlign: -1 }} /> {place(d.lastCity, d.lastState)} · IP {d.lastIp ?? '—'} · last used {timeAgo(d.lastUsedAt)} · trusted until {formatDateTime(d.trustedUntil)}
                  </div>
                </div>
                <button className="btn sm" onClick={() => void act(() => api.delete(`/security/devices/${d.id}`), loadDevices)}>
                  <Trash2 size={14} /> Remove
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === 'sessions' && (
          <div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button
                className="btn sm"
                disabled={sessions.length <= 1}
                onClick={() => void act(() => api.post('/security/sessions/revoke-others'), loadSessions)}
              >
                <LogOut size={14} /> Sign out all other sessions
              </button>
            </div>
            {sessions.map((s) => (
              <div className="security-item" key={s.id}>
                <span className="security-icon">{s.deviceType ? <DeviceIcon type={s.deviceType} /> : <Monitor size={20} />}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {s.browser ?? 'Browser'} on {s.os ?? 'Unknown OS'} {s.isCurrent && <span className="badge accent">Current session</span>}
                  </div>
                  <div className="subtle">
                    {place(s.city)} · IP {s.ip ?? '—'} · signed in {formatDateTime(s.createdAt)} · active {timeAgo(s.lastSeenAt)}
                  </div>
                </div>
                {!s.isCurrent && (
                  <button className="btn sm" onClick={() => void act(() => api.delete(`/security/sessions/${s.id}`), loadSessions)}>
                    Sign out
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
