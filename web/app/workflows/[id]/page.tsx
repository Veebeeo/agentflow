'use client';

/**
 * The builder.
 *
 * Two rules shape this screen:
 *   - a step is an ordered position, so reordering is explicit up and down
 *     rather than drag and drop, which keeps it keyboard reachable and makes
 *     the saved positions obvious
 *   - privileged step types are visibly unavailable to editors rather than
 *     silently failing on save, because a permission you only discover by
 *     hitting it is a bad permission
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppShell } from '../../../components/AppShell';
import { Pill } from '../../../components/Pill';
import { gql } from '../../../lib/gql';
import {
  ADD_TRIGGER,
  CREATE_WEBHOOK_TRIGGER,
  DELETE_TRIGGER,
  SAVE_STEPS,
  TRIGGER_RUN,
  WORKFLOW_DETAIL,
} from '../../../lib/queries';
import { canAddPrivilegedStep, canEdit, canTrigger, useSession } from '../../../lib/session';
import { STEP_LABELS, TRIGGER_LABELS, pad, timeAgo } from '../../../lib/format';
import type { StepType, WorkflowRow, WorkflowStepRow } from '../../../lib/types';

interface FieldSpec {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'json';
  options?: string[];
  placeholder?: string;
  help?: string;
}

/**
 * Config fields per step type. Placeholders double as the documentation for
 * the templating syntax, which is where people actually look for it.
 */
const CONFIG_FIELDS: Record<StepType, FieldSpec[]> = {
  llm_call: [
    {
      key: 'prompt',
      label: 'Prompt',
      kind: 'textarea',
      placeholder: 'Classify this message. Reply with PRIORITY: high or PRIORITY: low.\n\n{{run.input.message}}',
      help: 'Reference the trigger payload as {{run.input.field}} and earlier results as {{steps.0.output.text}}.',
    },
    { key: 'system', label: 'System instruction', kind: 'text', placeholder: 'You are a support triage assistant.' },
    { key: 'max_tokens', label: 'Max tokens', kind: 'number', placeholder: '256' },
  ],
  http_request: [
    { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://httpbin.org/post' },
    { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { key: 'headers', label: 'Headers', kind: 'json', placeholder: '{ "authorization": "Bearer {{secrets.API_KEY}}" }' },
    { key: 'body', label: 'Body', kind: 'json', placeholder: '{ "summary": "{{steps.0.output.text}}" }' },
  ],
  db_write: [
    { key: 'collection', label: 'Collection', kind: 'text', placeholder: 'triage_results' },
    { key: 'payload', label: 'Record', kind: 'json', placeholder: '{ "verdict": "{{steps.0.output.text}}" }' },
  ],
  notify: [
    { key: 'channel', label: 'Channel', kind: 'select', options: ['slack', 'email'] },
    { key: 'target', label: 'Send to', kind: 'text', placeholder: '#support-alerts' },
    { key: 'subject', label: 'Subject', kind: 'text', placeholder: 'Urgent ticket' },
    { key: 'body', label: 'Message', kind: 'textarea', placeholder: '{{steps.0.output.text}}' },
  ],
  conditional_branch: [
    { key: 'source', label: 'Look at', kind: 'text', placeholder: '{{steps.0.output.text}}' },
    {
      key: 'operator',
      label: 'Test',
      kind: 'select',
      options: ['contains', 'not_contains', 'equals', 'starts_with', 'matches', 'gt', 'lt', 'is_true'],
    },
    { key: 'value', label: 'Compare with', kind: 'text', placeholder: 'high' },
    { key: 'on_true', label: 'If it matches, go to step', kind: 'number', placeholder: '2' },
    {
      key: 'on_false',
      label: 'Otherwise go to step',
      kind: 'number',
      placeholder: '4',
      help: 'Positions are zero based and must be after this step, so a workflow always terminates.',
    },
  ],
  approval_gate: [
    {
      key: 'instructions',
      label: 'What the approver should check',
      kind: 'textarea',
      placeholder: 'Confirm the draft reply before it is sent to the customer.',
    },
  ],
};

const PRIVILEGED: StepType[] = ['db_write', 'notify'];

export default function WorkflowPage() {
  return (
    <AppShell>
      <Builder />
    </AppShell>
  );
}

interface DraftStep {
  key: string;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
  retry_limit: number;
  timeout_ms: number;
}

function toDraft(step: WorkflowStepRow): DraftStep {
  return {
    key: step.id,
    name: step.name,
    type: step.type,
    config: step.config ?? {},
    retry_limit: step.retry_limit,
    timeout_ms: step.timeout_ms,
  };
}

function Builder() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const workflowId = params.id;
  const { role } = useSession();

  const [workflow, setWorkflow] = useState<WorkflowRow | null>(null);
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [status, setStatus] = useState<{ kind: 'info' | 'error' | 'warn'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await gql<{ workflows_by_pk: WorkflowRow | null }>(WORKFLOW_DETAIL, { workflowId });
      setWorkflow(data.workflows_by_pk);
      setSteps((data.workflows_by_pk?.steps ?? []).map(toDraft));
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load the workflow.' });
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const editable = canEdit(role);

  const addStep = (type: StepType) => {
    setSteps((current) => [
      ...current,
      {
        key: `new-${Date.now()}-${current.length}`,
        name: STEP_LABELS[type] ?? type,
        type,
        config: {},
        retry_limit: type === 'llm_call' || type === 'http_request' ? 1 : 0,
        timeout_ms: 20000,
      },
    ]);
  };

  const move = (index: number, delta: number) => {
    setSteps((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return current;
      next[index] = b;
      next[target] = a;
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await gql(SAVE_STEPS, {
        workflowId,
        steps: steps.map((step, index) => ({
          workflow_id: workflowId,
          position: index,
          name: step.name.trim() || (STEP_LABELS[step.type] ?? step.type),
          type: step.type,
          config: step.config,
          retry_limit: step.retry_limit,
          timeout_ms: step.timeout_ms,
        })),
      });
      setStatus({ kind: 'info', text: 'Saved.' });
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save.';
      setStatus({
        kind: 'error',
        // Hasura's permission error is accurate but not readable, so name the
        // rule that actually fired.
        text: /permission|not allowed|check constraint/i.test(message)
          ? 'Saving was refused. Save a record and Send an alert steps can only be added by an owner.'
          : message,
      });
    } finally {
      setSaving(false);
    }
  };

  const startRun = async () => {
    setStarting(true);
    setStatus(null);
    try {
      const data = await gql<{ triggerWorkflowRun: { workflow_run_id: string } }>(TRIGGER_RUN, {
        workflowId,
        input: { message: 'Our checkout has been down for an hour, this is urgent.', source: 'manual' },
      });
      router.push(`/runs/${data.triggerWorkflowRun.workflow_run_id}`);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start the run.' });
      setStarting(false);
    }
  };

  const stepCountLabel = useMemo(
    () => `${steps.length} step${steps.length === 1 ? '' : 's'}`,
    [steps.length],
  );

  if (loading) {
    return (
      <div className="page">
        <p className="mono muted">Loading…</p>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="page">
        <div className="empty">
          <p>
            <strong>No workflow here.</strong>
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
          <Link href="/dashboard" className="eyebrow">
            ← workflows
          </Link>
          <h1>{workflow.name}</h1>
          <p className="subtitle">{stepCountLabel} · created {timeAgo(workflow.created_at)}</p>
        </div>
        <div className="row">
          {editable && (
            <button type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save steps'}
            </button>
          )}
          {/* Hidden entirely for viewers. The action refuses them anyway. */}
          {canTrigger(role) && (
            <button type="button" className="btn-primary" onClick={startRun} disabled={starting || steps.length === 0}>
              {starting ? 'Starting…' : 'Run'}
            </button>
          )}
        </div>
      </div>

      {status && <div className={`notice notice-${status.kind}`} style={{ marginBottom: '1rem' }}>{status.text}</div>}

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h2>Steps</h2>
            <span className="eyebrow">runs top to bottom</span>
          </div>

          {steps.length === 0 && (
            <div className="empty">
              <p style={{ marginBottom: 0 }}>Add a step to get started.</p>
            </div>
          )}

          <div className="rail">
            {steps.map((step, index) => (
              <div className="rail-node" key={step.key} data-position={pad(index)} data-state="pending">
                <div className="rail-body">
                  <div className="rail-title">
                    <input
                      aria-label={`Step ${index + 1} name`}
                      value={step.name}
                      disabled={!editable}
                      onChange={(e) =>
                        setSteps((c) => c.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)))
                      }
                      style={{ width: 220 }}
                    />
                    <select
                      aria-label={`Step ${index + 1} type`}
                      value={step.type}
                      disabled={!editable}
                      onChange={(e) =>
                        setSteps((c) =>
                          c.map((s, i) => (i === index ? { ...s, type: e.target.value as StepType, config: {} } : s)),
                        )
                      }
                      style={{ width: 190 }}
                    >
                      {(Object.keys(CONFIG_FIELDS) as StepType[]).map((type) => (
                        <option
                          key={type}
                          value={type}
                          disabled={PRIVILEGED.includes(type) && !canAddPrivilegedStep(role)}
                        >
                          {STEP_LABELS[type]}
                          {PRIVILEGED.includes(type) ? ' · owner only' : ''}
                        </option>
                      ))}
                    </select>

                    <span style={{ flex: 1 }} />

                    {editable && (
                      <>
                        <button type="button" className="btn-small" onClick={() => move(index, -1)} disabled={index === 0}>
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn-small"
                          onClick={() => move(index, 1)}
                          disabled={index === steps.length - 1}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn-small btn-danger"
                          onClick={() => setSteps((c) => c.filter((_, i) => i !== index))}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>

                  <details className="disclose" open={index === steps.length - 1}>
                    <summary>settings</summary>
                    <div style={{ marginTop: '0.6rem' }}>
                      <StepConfig
                        step={step}
                        disabled={!editable}
                        onChange={(config) =>
                          setSteps((c) => c.map((s, i) => (i === index ? { ...s, config } : s)))
                        }
                      />
                      {(step.type === 'llm_call' || step.type === 'http_request') && (
                        <div className="field" style={{ maxWidth: 200 }}>
                          <label>Retries after a failure</label>
                          <input
                            type="number"
                            min={0}
                            max={5}
                            disabled={!editable}
                            value={step.retry_limit}
                            onChange={(e) =>
                              setSteps((c) =>
                                c.map((s, i) =>
                                  i === index ? { ...s, retry_limit: Number(e.target.value) } : s,
                                ),
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            ))}
          </div>

          {editable && (
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <span className="eyebrow">add</span>
              {(Object.keys(CONFIG_FIELDS) as StepType[]).map((type) => {
                const blocked = PRIVILEGED.includes(type) && !canAddPrivilegedStep(role);
                return (
                  <button
                    key={type}
                    type="button"
                    className="btn-small"
                    disabled={blocked}
                    title={blocked ? 'Only an owner can add this step type' : undefined}
                    onClick={() => addStep(type)}
                  >
                    {STEP_LABELS[type]}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <Triggers workflow={workflow} onChanged={load} />

        <div className="card">
          <div className="card-head">
            <h2>Recent runs</h2>
          </div>
          {workflow.runs.length === 0 && <p className="mono muted">No runs yet.</p>}
          {workflow.runs.map((run) => (
            <div className="list-row" key={run.id}>
              <div className="list-row-main">
                <Link href={`/runs/${run.id}`} className="mono">
                  {run.id.slice(0, 8)}
                </Link>
                <div className="rail-meta">
                  {run.trigger_type} · {timeAgo(run.created_at)}
                </div>
              </div>
              <Pill status={run.status} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepConfig({
  step,
  disabled,
  onChange,
}: {
  step: DraftStep;
  disabled: boolean;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const fields = CONFIG_FIELDS[step.type] ?? [];

  const set = (key: string, value: unknown) => onChange({ ...step.config, [key]: value });

  return (
    <>
      {fields.map((field) => {
        const raw = step.config[field.key];
        const id = `${step.key}-${field.key}`;

        if (field.kind === 'json') {
          const text = raw === undefined || raw === null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          return (
            <div className="field" key={field.key}>
              <label htmlFor={id}>{field.label}</label>
              <textarea
                id={id}
                disabled={disabled}
                placeholder={field.placeholder}
                value={text}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value.trim() === '') {
                    set(field.key, undefined);
                    return;
                  }
                  try {
                    // Keep valid JSON as an object so templating can walk into
                    // it; hold anything else as text until it parses.
                    set(field.key, JSON.parse(value));
                  } catch {
                    set(field.key, value);
                  }
                }}
              />
              {field.help && <div className="help">{field.help}</div>}
            </div>
          );
        }

        return (
          <div className="field" key={field.key}>
            <label htmlFor={id}>{field.label}</label>
            {field.kind === 'textarea' ? (
              <textarea
                id={id}
                disabled={disabled}
                placeholder={field.placeholder}
                value={String(raw ?? '')}
                onChange={(e) => set(field.key, e.target.value)}
              />
            ) : field.kind === 'select' ? (
              <select
                id={id}
                disabled={disabled}
                value={String(raw ?? field.options?.[0] ?? '')}
                onChange={(e) => set(field.key, e.target.value)}
              >
                {field.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type={field.kind === 'number' ? 'number' : 'text'}
                disabled={disabled}
                placeholder={field.placeholder}
                value={String(raw ?? '')}
                onChange={(e) =>
                  set(field.key, field.kind === 'number' ? Number(e.target.value) : e.target.value)
                }
              />
            )}
            {field.help && <div className="help">{field.help}</div>}
          </div>
        );
      })}
    </>
  );
}

function Triggers({ workflow, onChanged }: { workflow: WorkflowRow; onChanged: () => void }) {
  const { role } = useSession();
  const [cron, setCron] = useState('*/5 * * * *');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>How it starts</h2>
        <span className="eyebrow">manual is always available</span>
      </div>

      {workflow.triggers.length === 0 && (
        <p className="mono muted">Only the Run button so far.</p>
      )}

      {workflow.triggers.map((trigger) => (
        <div className="list-row" key={trigger.id}>
          <div className="list-row-main">
            <strong>{TRIGGER_LABELS[trigger.type] ?? trigger.type}</strong>
            <div className="rail-meta">
              {trigger.type === 'scheduled' && `${trigger.cron_expression} · next ${trigger.next_run_at ?? 'pending'}`}
              {trigger.type === 'webhook' && `id ${trigger.id.slice(0, 8)} · last fired ${trigger.last_fired_at ?? 'never'}`}
              {trigger.type === 'database_event' && `watching ${String(trigger.config.table ?? 'leads')}`}
            </div>
          </div>
          <Pill status={trigger.is_enabled ? 'succeeded' : 'skipped'} />
          {canEdit(role) && (
            <button
              type="button"
              className="btn-small btn-danger"
              disabled={busy}
              onClick={() => run(async () => { await gql(DELETE_TRIGGER, { id: trigger.id }); })}
            >
              Remove
            </button>
          )}
        </div>
      ))}

      {canEdit(role) && (
        <>
          <hr className="divider" />
          <div className="row">
            <input
              aria-label="Cron expression"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              style={{ width: 150 }}
            />
            <button
              type="button"
              className="btn-small"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await gql(ADD_TRIGGER, {
                    object: {
                      workflow_id: workflow.id,
                      type: 'scheduled',
                      cron_expression: cron,
                      config: { timezone: 'UTC' },
                    },
                  });
                })
              }
            >
              Add schedule
            </button>

            <button
              type="button"
              className="btn-small"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await gql(ADD_TRIGGER, {
                    object: {
                      workflow_id: workflow.id,
                      type: 'database_event',
                      config: { table: 'leads', operation: 'INSERT' },
                    },
                  });
                })
              }
            >
              Start on a new lead
            </button>

            <button
              type="button"
              className="btn-small"
              disabled={busy || role !== 'owner'}
              title={role !== 'owner' ? 'Only an owner can expose a workflow to the outside world' : undefined}
              onClick={() =>
                run(async () => {
                  const data = await gql<{ createWebhookTrigger: { token: string } }>(CREATE_WEBHOOK_TRIGGER, {
                    workflowId: workflow.id,
                  });
                  setToken(data.createWebhookTrigger.token);
                })
              }
            >
              Create webhook · owner only
            </button>
          </div>

          {error && (
            <div className="notice notice-error" style={{ marginTop: '0.7rem' }}>
              {error}
            </div>
          )}

          {token && (
            <div className="notice notice-warn" style={{ marginTop: '0.7rem' }}>
              <strong>Copy this token now. It is not shown again.</strong>
              <pre className="payload">{token}</pre>
              Send it as <span className="mono">Authorization: Bearer …</span> with a{' '}
              <span className="mono">triggerWorkflowWebhook</span> mutation.
            </div>
          )}
        </>
      )}
    </div>
  );
}
