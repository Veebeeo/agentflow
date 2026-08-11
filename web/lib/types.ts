export type OrgRole = 'owner' | 'editor' | 'viewer';

export type StepType =
  | 'llm_call'
  | 'http_request'
  | 'db_write'
  | 'notify'
  | 'conditional_branch'
  | 'approval_gate';

export type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event';

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'rejected';

export interface Membership {
  id: string;
  role: OrgRole;
  org_id: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    usage: OrgUsage | null;
  };
}

export interface OrgUsage {
  quota_calls_allowed: number;
  quota_calls_used: number;
  quota_calls_remaining: number;
  runs_started: number;
  runs_succeeded: number;
  runs_failed: number;
  runs_awaiting_approval: number;
  avg_run_seconds: number;
}

export interface WorkflowStepRow {
  id: string;
  position: number;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
  retry_limit: number;
  timeout_ms: number;
}

export interface WorkflowTriggerRow {
  id: string;
  type: TriggerType;
  is_enabled: boolean;
  config: Record<string, unknown>;
  cron_expression: string | null;
  next_run_at: string | null;
  last_fired_at: string | null;
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  created_at: string;
  finished_at: string | null;
}

export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  org_id: string;
  created_at: string;
  steps: WorkflowStepRow[];
  triggers: WorkflowTriggerRow[];
  runs: RunSummary[];
}

export interface StepRunRow {
  id: string;
  position: number;
  name: string;
  step_type: StepType;
  status: StepRunStatus;
  attempt: number;
  input: unknown;
  output: unknown;
  error: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunDetail {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  error: string | null;
  billable_calls: number;
  input: unknown;
  output: unknown;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  workflow: { id: string; name: string; org_id: string };
  step_runs: StepRunRow[];
}
