'use client';

/**
 * The live run view.
 *
 * Nothing here polls and nothing refetches on a timer. Two subscriptions are
 * open: one on step_runs filtered to this run, one on the run header. Every
 * state the executor writes arrives over those sockets, which is why the paused
 * state appears the instant the engine stops, and the rest of the rail fills in
 * on its own after an approval.
 *
 * If the run belongs to another organization, the subscription is not an error.
 * It is simply empty, because Hasura applies the same row filter to the socket
 * as it does to a query. That is the behaviour worth demonstrating.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { Pill } from '../../../components/Pill';
import { gql } from '../../../lib/gql';
import { APPROVE_STEP, RUN_DETAIL, RUN_STATUS_SUBSCRIPTION, STEP_RUNS_SUBSCRIPTION } from '../../../lib/queries';
import { subscribe } from '../../../lib/subscribe';
import { canTrigger, useSession } from '../../../lib/session';
import { STEP_LABELS, duration, pad, pretty } from '../../../lib/format';
import type { RunDetail, RunStatus, StepRunRow } from '../../../lib/types';

export default function RunPage() {
  return (
    <AppShell>
      <RunView />
    </AppShell>
  );
}

interface RunHeader {
  id: string;
  status: RunStatus;
  error: string | null;
  billable_calls: number;
  started_at: string | null;
  finished_at: string | null;
}

function RunView() {
  const params = useParams<{ id: string }>();
  const runId = params.id;
  const { role } = useSession();

  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [header, setHeader] = useState<RunHeader | null>(null);
  const [stepRuns, setStepRuns] = useState<StepRunRow[]>([]);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gql<{ workflow_runs_by_pk: RunDetail | null }>(RUN_DETAIL, { runId })
      .then((data) => {
        if (cancelled) return;
        setDetail(data.workflow_runs_by_pk);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this run.'))
      .finally(() => !cancelled && setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    const steps = subscribe<{ step_runs: StepRunRow[] }>(
      STEP_RUNS_SUBSCRIPTION,
      { runId },
      {
        onData: (data) => setStepRuns(data.step_runs),
        onStatus: setConnection,
        onError: (err) => setError(String(err)),
      },
    );

    const runStatus = subscribe<{ workflow_runs_by_pk: RunHeader | null }>(
      RUN_STATUS_SUBSCRIPTION,
      { runId },
      { onData: (data) => setHeader(data.workflow_runs_by_pk) },
    );

    return () => {
      steps.unsubscribe();
      runStatus.unsubscribe();
    };
  }, [runId]);

  const status = header?.status ?? detail?.status ?? 'queued';
  const pausedStep = stepRuns.find((step) => step.status === 'paused');

  const approve = useCallback(
    async (stepRunId: string, decision: 'approve' | 'reject', note: string) => {
      setError(null);
      try {
        await gql(APPROVE_STEP, { stepRunId, decision, note: note || null });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That decision was refused.');
      }
    },
    [],
  );

  if (loaded && !detail) {
    return (
      <div className="page">
        <div className="empty">
          <p>
            <strong>No run here.</strong>
          </p>
          <p style={{ marginBottom: 0 }}>
            It does not exist, or it belongs to an organization you are not a member of.{' '}
            <Link href="/dashboard">Back to workflows</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          {detail && (
            <Link href={`/workflows/${detail.workflow.id}`} className="eyebrow">
              ← {detail.workflow.name}
            </Link>
          )}
          <h1 className="row" style={{ gap: '0.75rem' }}>
            Run <span className="mono">{runId.slice(0, 8)}</span>
            <Pill status={status} />
          </h1>
          <p className="subtitle">
            {detail?.trigger_type && `started by ${detail.trigger_type}`}
            {header?.started_at && ` · ${duration(header.started_at, header.finished_at)}`}
            {header && ` · ${header.billable_calls} billed calls`}
          </p>
        </div>
        <span className={`pill pill-${connection === 'live' ? 'running' : 'pending'}`}>
          {connection === 'live' ? 'live' : connection}
        </span>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {header?.error && (
        <div className="notice notice-error" style={{ marginBottom: '1rem' }}>
          {header.error}
        </div>
      )}

      {pausedStep && (
        <ApprovalPanel
          step={pausedStep}
          canDecide={canTrigger(role)}
          onDecide={(decision, note) => approve(pausedStep.id, decision, note)}
        />
      )}

      <div className="card">
        <div className="card-head">
          <h2>Steps</h2>
          <span className="eyebrow">updating without a refresh</span>
        </div>

        {stepRuns.length === 0 && <p className="mono muted">Waiting for the executor to pick this up…</p>}

        <div className="rail">
          {stepRuns.map((step) => (
            <div className="rail-node" key={step.id} data-position={pad(step.position)} data-state={step.status}>
              <div className="rail-body">
                <div className="rail-title">
                  <strong>{step.name}</strong>
                  <span className="mono muted">{STEP_LABELS[step.step_type] ?? step.step_type}</span>
                  <span style={{ flex: 1 }} />
                  <Pill status={step.status} />
                </div>

                <div className="rail-meta">
                  {step.started_at ? duration(step.started_at, step.finished_at) : 'not started'}
                  {step.attempt > 0 && ` · ${step.attempt} failed ${step.attempt === 1 ? 'attempt' : 'attempts'}`}
                  {step.approved_at && ' · decided by an approver'}
                </div>

                {step.error && (
                  <div className="notice notice-error" style={{ marginTop: '0.5rem' }}>
                    {step.error}
                  </div>
                )}

                {step.output !== null && step.output !== undefined && (
                  <details className="disclose" open={step.status === 'running' || step.status === 'paused'}>
                    <summary>output</summary>
                    <pre className="payload">{pretty(step.output)}</pre>
                  </details>
                )}

                {step.input !== null && step.input !== undefined && (
                  <details className="disclose">
                    <summary>input</summary>
                    <pre className="payload">{pretty(step.input)}</pre>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {detail && (
        <details className="disclose card" style={{ marginTop: '1rem' }}>
          <summary>trigger payload</summary>
          <pre className="payload">{pretty(detail.input)}</pre>
        </details>
      )}
    </div>
  );
}

function ApprovalPanel({
  step,
  canDecide,
  onDecide,
}: {
  step: StepRunRow;
  canDecide: boolean;
  onDecide: (decision: 'approve' | 'reject', note: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await onDecide(decision, note);
    } finally {
      setBusy(false);
    }
  };

  const instructions =
    step.input && typeof step.input === 'object'
      ? ((step.input as { instructions?: string }).instructions ?? null)
      : null;

  return (
    <div className="card" style={{ borderLeft: '3px solid var(--state-paused)', marginBottom: '1rem' }}>
      <div className="card-head">
        <span className="eyebrow">paused at step {pad(step.position)}</span>
      </div>
      <h2 style={{ marginBottom: '0.4rem' }}>{step.name}</h2>
      <p className="subtitle">
        {instructions ?? 'This run stops here until someone decides. Nothing after this step has executed.'}
      </p>

      {!canDecide ? (
        <div className="notice notice-warn">
          Viewers cannot decide approvals. Ask an owner or an editor in this organization.
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="approval-note">Note (optional)</label>
            <input id="approval-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="row">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => decide('approve')}>
              {busy ? 'Working…' : 'Approve and continue'}
            </button>
            <button type="button" className="btn-danger" disabled={busy} onClick={() => decide('reject')}>
              Reject
            </button>
          </div>
        </>
      )}
    </div>
  );
}
