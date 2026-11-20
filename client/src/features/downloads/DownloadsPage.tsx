import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, errorMessage } from '../../lib/api';
import { formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { ERROR_COPY, downloadsApi, startBrowserDownload, type DownloadItem, type DownloadStatus, type Quota } from './api';
import './downloads.css';

export const STATUS: Record<DownloadStatus, { label: string; cls: string }> = {
  AUTHORIZED: { label: 'Starting', cls: 'info' },
  IN_PROGRESS: { label: 'Downloading', cls: 'info' },
  COMPLETED: { label: 'Completed', cls: 'success' },
  INTERRUPTED: { label: 'Interrupted', cls: 'warning' },
  FAILED: { label: 'Failed', cls: 'danger' },
};

function useCountdown(target: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!target) return '';
  const ms = Math.max(0, new Date(target).getTime() - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms / 60_000) % 60);
  const s = Math.floor((ms / 1000) % 60);
  return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function QuotaCard({ quota }: { quota: Quota }) {
  const countdown = useCountdown(quota.resetsAt);
  const pct = (used: number, limit: number) => Math.min(100, (used / Math.max(1, limit)) * 100);
  return (
    <div className="card dl-quota">
      <div className="row wrap">
        <h2 style={{ margin: 0 }}>Download quota</h2>
        <span className={`badge plan-${quota.plan}`}>{quota.plan}</span>
        {quota.planExpired && <span className="badge danger">Subscription expired</span>}
        <div className="spacer" />
        <Link to="/plans" className="btn sm">Get more downloads</Link>
      </div>
      <div className="dl-meters">
        <div>
          <div className="row"><span className="muted">Today</span><div className="spacer" /><strong>{quota.remainingToday} left</strong></div>
          <div className="dl-meter"><span style={{ width: `${pct(quota.usedToday, quota.dailyLimit)}%` }} /></div>
          <div className="subtle">{quota.usedToday} of {quota.dailyLimit} used · resets in {countdown} (midnight IST)</div>
        </div>
        <div>
          <div className="row"><span className="muted">This month</span><div className="spacer" /><strong>{quota.remainingThisMonth} left</strong></div>
          <div className="dl-meter"><span style={{ width: `${pct(quota.usedThisMonth, quota.monthlyLimit)}%` }} /></div>
          <div className="subtle">{quota.usedThisMonth} of {quota.monthlyLimit} used</div>
        </div>
      </div>
      <p className="subtle" style={{ margin: '12px 0 0' }}>
        Downloading the same video again within {quota.duplicateWindowHours}h doesn’t count twice. Failed downloads that
        never started are refunded automatically.
      </p>
    </div>
  );
}

export function DownloadsPage() {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string; upgrade?: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await downloadsApi.list(page);
      setItems(res.items);
      setQuota(res.quota);
      setTotal(res.total);
      setPageSize(res.pageSize);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep statuses fresh while something is downloading.
  const active = items.some((i) => i.status === 'AUTHORIZED' || i.status === 'IN_PROGRESS');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [active, load]);

  async function act(item: DownloadItem) {
    if (busyId) return;
    setBusyId(item.id);
    setNotice(null);
    try {
      const retryable = item.status === 'INTERRUPTED' || item.status === 'FAILED';
      const res = retryable ? await downloadsApi.retry(item.id) : await downloadsApi.authorize(item.video.id);
      startBrowserDownload(res.url, `${item.video.title}.mp4`);
      setQuota(res.quota);
      setNotice({
        kind: 'success',
        text: res.countsToQuota ? 'Download started.' : 'Download started — it doesn’t count against your quota.',
      });
      setTimeout(() => void load(), 1200);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const copy = code ? ERROR_COPY[code] : undefined;
      setNotice({ kind: 'error', text: `${copy ? `${copy.title}: ` : ''}${errorMessage(err)}`, upgrade: copy?.upgrade });
    } finally {
      setBusyId(null);
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="container">
      <h1 className="page-title">Downloads</h1>
      <p className="page-subtitle">Videos you’ve downloaded for offline viewing.</p>

      <div className="stack">
        {quota && <QuotaCard quota={quota} />}
        {notice && (
          <div className={`alert ${notice.kind}`}>
            {notice.text} {notice.upgrade && <Link to="/plans" className="dl-link">View plans →</Link>}
          </div>
        )}
        {error && <div className="alert error">{error}</div>}

        <div className="card" style={{ padding: 0 }}>
          {loading ? (
            <div className="empty"><div className="spinner" style={{ margin: '0 auto' }} /></div>
          ) : items.length === 0 ? (
            <div className="empty">
              <Download size={32} style={{ margin: '0 auto 8px', display: 'block' }} />
              No downloads yet. Use the Download button on any video.
              <div style={{ marginTop: 12 }}><Link to="/" className="btn primary">Browse videos</Link></div>
            </div>
          ) : (
            <ul className="dl-list">
              {items.map((item) => {
                const st = STATUS[item.status];
                const retryable = item.status === 'INTERRUPTED' || item.status === 'FAILED';
                return (
                  <li key={item.id} className="dl-item">
                    <Link to={`/watch/${item.video.id}`} className="dl-thumb">
                      <img src={item.video.thumbnailUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                      <span className="dl-duration">{formatDuration(item.video.durationSec)}</span>
                    </Link>
                    <div className="dl-info">
                      <Link to={`/watch/${item.video.id}`} className="dl-title">{item.video.title}</Link>
                      <div className="dl-meta">
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                        <span className={`badge plan-${item.plan}`}>{item.plan}</span>
                        {!item.countsToQuota && <span className="badge" title="Didn’t use quota">Free re-download</span>}
                      </div>
                      <div className="subtle">
                        {formatDateTime(item.createdAt)} · {formatBytes(item.fileSizeBytes)}
                        {item.status === 'IN_PROGRESS' || item.status === 'INTERRUPTED'
                          ? ` · ${Math.round((item.bytesSent / Math.max(1, item.fileSizeBytes)) * 100)}%`
                          : ''}
                        {item.browser ? ` · ${item.browser} on ${item.os ?? 'unknown OS'}` : ''}
                      </div>
                      {item.failureReason && retryable && <div className="subtle">{item.failureReason}</div>}
                    </div>
                    <div className="dl-actions">
                      {item.status !== 'AUTHORIZED' && item.status !== 'IN_PROGRESS' && (
                        <button className="btn sm" disabled={busyId === item.id} onClick={() => void act(item)}>
                          {retryable ? <RefreshCw size={14} /> : <Download size={14} />}
                          {retryable ? 'Retry' : 'Download again'}
                        </button>
                      )}
                      {item.url && (
                        <button className="btn sm" onClick={() => startBrowserDownload(item.url!, `${item.video.title}.mp4`)}>
                          <Download size={14} /> Save file
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {pages > 1 && (
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <span className="subtle">Page {page} of {pages}</span>
            <button className="btn sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}
