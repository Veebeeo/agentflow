'use client';

/**
 * The usage indicator, fed by the org_usage_current_period view rather than by
 * counting rows in the client.
 */
import type { OrgUsage } from '../lib/types';

export function QuotaMeter({ usage, orgName }: { usage: OrgUsage | null; orgName: string }) {
  if (!usage) return null;

  const ratio = usage.quota_calls_allowed
    ? Math.min(1, usage.quota_calls_used / usage.quota_calls_allowed)
    : 0;
  const level = ratio >= 1 ? 'full' : ratio >= 0.8 ? 'warn' : 'ok';

  return (
    <div className="card card-tight">
      <div className="card-head" style={{ marginBottom: '0.4rem' }}>
        <span className="eyebrow">this period · {orgName}</span>
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="mono">
          {usage.quota_calls_used} / {usage.quota_calls_allowed} external calls
        </span>
        <span className="mono muted">{usage.quota_calls_remaining} left</span>
      </div>

      <div className="meter">
        <div className="meter-fill" data-level={level} style={{ width: `${ratio * 100}%` }} />
      </div>

      <div className="stat-row">
        <div>
          <div className="stat-value">{usage.runs_started}</div>
          <div className="eyebrow">runs</div>
        </div>
        <div>
          <div className="stat-value" style={{ color: 'var(--state-ok)' }}>
            {usage.runs_succeeded}
          </div>
          <div className="eyebrow">succeeded</div>
        </div>
        <div>
          <div className="stat-value" style={{ color: 'var(--state-fail)' }}>
            {usage.runs_failed}
          </div>
          <div className="eyebrow">failed</div>
        </div>
        <div>
          <div className="stat-value" style={{ color: 'var(--state-paused)' }}>
            {usage.runs_awaiting_approval}
          </div>
          <div className="eyebrow">awaiting you</div>
        </div>
        <div>
          <div className="stat-value">{usage.avg_run_seconds}s</div>
          <div className="eyebrow">avg run</div>
        </div>
      </div>
    </div>
  );
}
