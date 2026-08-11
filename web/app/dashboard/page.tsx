'use client';

/**
 * The dashboard answers three questions: what can this organization run, what
 * has it run lately, and how much of its allowance is left.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '../../components/AppShell';
import { Pill } from '../../components/Pill';
import { QuotaMeter } from '../../components/QuotaMeter';
import { gql } from '../../lib/gql';
import {
  CREATE_LEAD,
  CREATE_ORGANIZATION,
  CREATE_WORKFLOW,
  ORG_RUNS,
  ORG_WORKFLOWS,
} from '../../lib/queries';
import { canEdit, canTrigger, useSession } from '../../lib/session';
import { timeAgo } from '../../lib/format';
import type { RunStatus, TriggerType, WorkflowRow } from '../../lib/types';

interface RunListItem {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  created_at: string;
  finished_at: string | null;
  workflow: { id: string; name: string };
}

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const { activeOrgId, activeOrg, role, memberships, reloadMemberships } = useSession();
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!activeOrgId) {
      setWorkflows([]);
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [workflowData, runData] = await Promise.all([
        gql<{ workflows: WorkflowRow[] }>(ORG_WORKFLOWS, { orgId: activeOrgId }),
        gql<{ workflow_runs: RunListItem[] }>(ORG_RUNS, { orgId: activeOrgId }),
      ]);
      setWorkflows(workflowData.workflows);
      setRuns(runData.workflow_runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this organization.');
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (memberships.length === 0) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="page-head-text">
            <h1>Create your first organization</h1>
            <p className="subtitle">
              Workflows, runs and quota all belong to an organization. You will be its owner.
            </p>
          </div>
        </div>
        <CreateOrganization onCreated={reloadMemberships} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>{activeOrg?.organization.name ?? 'Workflows'}</h1>
          <p className="subtitle">
            You are {role === 'owner' ? 'an owner' : role === 'editor' ? 'an editor' : 'a viewer'} here.
            {role === 'viewer' && ' Viewers can read runs but cannot start them.'}
          </p>
        </div>
      </div>

      <div className="stack">
        <QuotaMeter
          usage={activeOrg?.organization.usage ?? null}
          orgName={activeOrg?.organization.name ?? ''}
        />

        {error && <div className="notice notice-error">{error}</div>}

        <div className="card">
          <div className="card-head">
            <h2>Workflows</h2>
            {canEdit(role) && activeOrgId && <NewWorkflow orgId={activeOrgId} onCreated={load} />}
          </div>

          {loading && <p className="mono muted">Loading…</p>}

          {!loading && workflows.length === 0 && (
            <div className="empty">
              <p style={{ marginBottom: 0 }}>
                {canEdit(role)
                  ? 'Nothing here yet. Create a workflow and add its first step.'
                  : 'This organization has no workflows yet.'}
              </p>
            </div>
          )}

          {workflows.map((workflow) => {
            const lastRun = workflow.runs[0];
            return (
              <div className="list-row" key={workflow.id}>
                <div className="list-row-main">
                  <Link href={`/workflows/${workflow.id}`} style={{ fontWeight: 600 }}>
                    {workflow.name}
                  </Link>
                  <div className="rail-meta">
                    {workflow.steps.length} steps ·{' '}
                    {workflow.triggers.length > 0
                      ? workflow.triggers.map((t) => t.type).join(', ')
                      : 'manual only'}
                  </div>
                </div>
                {lastRun ? (
                  <Link href={`/runs/${lastRun.id}`} className="row" style={{ gap: '0.5rem' }}>
                    <Pill status={lastRun.status} />
                    <span className="mono muted">{timeAgo(lastRun.created_at)}</span>
                  </Link>
                ) : (
                  <span className="mono muted">never run</span>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid-2">
          <div className="card">
            <div className="card-head">
              <h2>Recent runs</h2>
            </div>
            {runs.length === 0 && <p className="mono muted">No runs yet.</p>}
            {runs.map((run) => (
              <div className="list-row" key={run.id}>
                <div className="list-row-main">
                  <Link href={`/runs/${run.id}`}>{run.workflow.name}</Link>
                  <div className="rail-meta">
                    {run.trigger_type} · {timeAgo(run.created_at)}
                  </div>
                </div>
                <Pill status={run.status} />
              </div>
            ))}
          </div>

          <div className="stack">
            {canTrigger(role) && activeOrgId && <LeadForm orgId={activeOrgId} onCreated={load} />}
            <CreateOrganization onCreated={reloadMemberships} compact />
          </div>
        </div>
      </div>
    </div>
  );
}

function NewWorkflow({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await gql(CREATE_WORKFLOW, { orgId, name, description: null });
      setName('');
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workflow.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn-primary btn-small" onClick={() => setOpen(true)}>
        New workflow
      </button>
    );
  }

  return (
    <div className="row">
      <input
        autoFocus
        placeholder="Support triage"
        value={name}
        onChange={(e) => setName(e.target.value)}
        style={{ width: 220 }}
      />
      <button type="button" className="btn-primary btn-small" disabled={busy || !name.trim()} onClick={submit}>
        Create
      </button>
      <button type="button" className="btn-small" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="notice notice-error">{error}</span>}
    </div>
  );
}

function CreateOrganization({ onCreated, compact }: { onCreated: () => Promise<void>; compact?: boolean }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await gql(CREATE_ORGANIZATION, { name, slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
      setName('');
      setSlug('');
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the organization.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ fontSize: compact ? '0.95rem' : undefined }}>New organization</h2>
      </div>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="org-name">Name</label>
          <input id="org-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="org-slug">Short name</label>
          <input
            id="org-slug"
            placeholder="acme-support"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          <div className="help">Lowercase letters, numbers and dashes. Left blank, it is derived from the name.</div>
        </div>
        {error && (
          <div className="notice notice-error" style={{ marginBottom: '0.7rem' }}>
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary btn-small" disabled={busy || !name.trim()}>
          Create organization
        </button>
      </form>
    </div>
  );
}

/**
 * Writes a row into the watched `leads` table. That insert fires the
 * lead_created event trigger, which starts every workflow in this organization
 * listening for it. No button in this app calls the executor for that path.
 */
function LeadForm({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
  const [email, setEmail] = useState('customer@example.com');
  const [message, setMessage] = useState('Our checkout has been down for an hour, this is urgent.');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await gql(CREATE_LEAD, { orgId, email, company: null, message });
      setNote('Lead saved. Any workflow watching this table has started.');
      onCreated();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not save the lead.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2 style={{ fontSize: '0.95rem' }}>Add a lead</h2>
        <span className="eyebrow">fires the database trigger</span>
      </div>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="lead-email">Email</label>
          <input id="lead-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="lead-message">Message</label>
          <textarea id="lead-message" required value={message} onChange={(e) => setMessage(e.target.value)} />
        </div>
        {note && (
          <div className="notice notice-info" style={{ marginBottom: '0.7rem' }}>
            {note}
          </div>
        )}
        <button type="submit" className="btn-small" disabled={busy}>
          Save lead
        </button>
      </form>
    </div>
  );
}
