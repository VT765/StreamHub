import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage } from '../../lib/api';
import { formatBytes, formatDateTime, formatDuration } from '../../lib/format';
import { downloadsApi, type DownloadItem, type Quota } from './api';
import { STATUS } from './DownloadsPage';
import './downloads.css';

/** Downloads summary for the profile page: remaining quota + the most recent downloads. */
export function ProfileDownloads() {
  const [data, setData] = useState<{ items: DownloadItem[]; total: number; quota: Quota } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    downloadsApi.list(1).then(setData, (err) => setError(errorMessage(err)));
  }, []);

  return (
    <section className="card stack">
      <div className="row wrap">
        <h2 style={{ margin: 0 }}>Downloads</h2>
        <div className="spacer" />
        <Link to="/downloads" className="btn sm">
          <Download size={14} /> View all{data ? ` (${data.total})` : ''}
        </Link>
      </div>
      {error && <div className="alert error">{error}</div>}
      {!data && !error && <div className="spinner" />}
      {data && (
        <>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className={`badge plan-${data.quota.plan}`}>{data.quota.plan}</span>
            <span className="muted">
              {data.quota.remainingToday} of {data.quota.dailyLimit} left today · {data.quota.remainingThisMonth} of{' '}
              {data.quota.monthlyLimit} left this month
            </span>
          </div>
          {data.items.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No downloads yet. Use the Download button on any video.</p>
          ) : (
            <ul className="dl-list">
              {data.items.slice(0, 3).map((item) => (
                <li key={item.id} className="dl-item profile-dl-item">
                  <Link to={`/watch/${item.video.id}`} className="dl-thumb">
                    <img src={item.video.thumbnailUrl} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                    <span className="dl-duration">{formatDuration(item.video.durationSec)}</span>
                  </Link>
                  <div className="dl-info">
                    <Link to={`/watch/${item.video.id}`} className="dl-title">{item.video.title}</Link>
                    <div className="dl-meta">
                      <span className={`badge ${STATUS[item.status].cls}`}>{STATUS[item.status].label}</span>
                      <span className={`badge plan-${item.plan}`}>{item.plan}</span>
                    </div>
                    <div className="subtle">{formatDateTime(item.createdAt)} · {formatBytes(item.fileSizeBytes)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
