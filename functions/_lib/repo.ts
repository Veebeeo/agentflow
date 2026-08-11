/**
 * Every database read and write the backend performs, in one place.
 *
 * Handlers never build GraphQL inline. Keeping it here means the org scoping on
 * each query is reviewable as a unit, and a new handler cannot quietly
 * introduce an unscoped read.
 */
import { adminGraphql } from './hasura';

export type OrgRole = 'owner' | 'editor' | 'viewer';

export type StepType =
  | 'llm_call'
  | 'http_request'
  | 'db_write'
  | 'notify'
  | 'conditional_branch'
  | 'approval_gate';

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'rejected';

export interface WorkflowStep {
  id: string;
  position: number;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
  retry_limit: number;
  timeout_ms: number;
}

export interface StepRunRow {
  id: string;
  position: number;
  status: StepRunStatus;
  step_type: StepType;
  output: unknown;
}

export interface RunForExecution {
  id: string;
  org_id: string;
  workflow_id: string;
  status: RunStatus;
  next_position: number;
  input: Record<string, unknown>;
  billable_calls: number;
  workflow: {
    id: string;
    name: string;
    is_active: boolean;
    steps: WorkflowStep[];
  };
  step_runs: StepRunRow[];
}

/* ------------------------------------------------------------------ */
/* Authorization lookups                                               */
/* ------------------------------------------------------------------ */

/**
 * The single source of truth for "may this user act on this workflow".
 * Returns null when the workflow does not exist OR the caller is not a member,
 * so callers cannot distinguish the two cases.
 */
export async function getWorkflowAccess(
  workflowId: string,
  userId: string,
): Promise<{
  workflowId: string;
  orgId: string;
  isActive: boolean;
  role: OrgRole;
  stepCount: number;
} | null> {
  const data = await adminGraphql<{
    workflows_by_pk: {
      id: string;
      org_id: string;
      is_active: boolean;
      steps_aggregate: { aggregate: { count: number } | null };
      organization: { members: Array<{ role: OrgRole }> };
    } | null;
  }>(
    `query WorkflowAccess($workflowId: uuid!, $userId: uuid!) {
       workflows_by_pk(id: $workflowId) {
         id
         org_id
         is_active
         steps_aggregate { aggregate { count } }
         organization {
           members(where: { user_id: { _eq: $userId } }) { role }
         }
       }
     }`,
    { workflowId, userId },
  );

  const workflow = data.workflows_by_pk;
  const membership = workflow?.organization.members[0];
  if (!workflow || !membership) return null;

  return {
    workflowId: workflow.id,
    orgId: workflow.org_id,
    isActive: workflow.is_active,
    role: membership.role,
    stepCount: workflow.steps_aggregate.aggregate?.count ?? 0,
  };
}

export async function getStepRunForApproval(
  stepRunId: string,
  userId: string,
): Promise<{
  stepRunId: string;
  runId: string;
  orgId: string;
  position: number;
  stepStatus: StepRunStatus;
  runStatus: RunStatus;
  role: OrgRole;
} | null> {
  const data = await adminGraphql<{
    step_runs_by_pk: {
      id: string;
      position: number;
      status: StepRunStatus;
      step_type: StepType;
      run: {
        id: string;
        status: RunStatus;
        org_id: string;
        organization: { members: Array<{ role: OrgRole }> };
      };
    } | null;
  }>(
    `query StepRunForApproval($stepRunId: uuid!, $userId: uuid!) {
       step_runs_by_pk(id: $stepRunId) {
         id
         position
         status
         step_type
         run {
           id
           status
           org_id
           organization {
             members(where: { user_id: { _eq: $userId } }) { role }
           }
         }
       }
     }`,
    { stepRunId, userId },
  );

  const stepRun = data.step_runs_by_pk;
  const membership = stepRun?.run.organization.members[0];
  if (!stepRun || !membership) return null;
  if (stepRun.step_type !== 'approval_gate') return null;

  return {
    stepRunId: stepRun.id,
    runId: stepRun.run.id,
    orgId: stepRun.run.org_id,
    position: stepRun.position,
    stepStatus: stepRun.status,
    runStatus: stepRun.run.status,
    role: membership.role,
  };
}

export async function getQuotaSnapshot(
  orgId: string,
): Promise<{ used: number; allowed: number; remaining: number }> {
  const data = await adminGraphql<{
    organizations_by_pk: { quota_calls_used: number; quota_calls_allowed: number } | null;
  }>(
    `query Quota($orgId: uuid!) {
       organizations_by_pk(id: $orgId) { quota_calls_used quota_calls_allowed }
     }`,
    { orgId },
  );
  const org = data.organizations_by_pk;
  if (!org) throw new Error('Organization not found');
  return {
    used: org.quota_calls_used,
    allowed: org.quota_calls_allowed,
    remaining: Math.max(0, org.quota_calls_allowed - org.quota_calls_used),
  };
}

/* ------------------------------------------------------------------ */
/* Quota                                                               */
/* ------------------------------------------------------------------ */

export async function reserveQuota(orgId: string, amount = 1): Promise<boolean> {
  // Zero rows back means the check failed, which is the whole signal.
  const data = await adminGraphql<{ reserve_org_quota: Array<{ id: string }> }>(
    `mutation Reserve($orgId: uuid!, $amount: Int!) {
       reserve_org_quota(args: { p_org: $orgId, p_amount: $amount }) { id }
     }`,
    { orgId, amount },
  );
  return data.reserve_org_quota.length > 0;
}

export async function releaseQuota(orgId: string, amount = 1): Promise<void> {
  await adminGraphql(
    `mutation Release($orgId: uuid!, $amount: Int!) {
       release_org_quota(args: { p_org: $orgId, p_amount: $amount }) { id }
     }`,
    { orgId, amount },
  );
}

/* ------------------------------------------------------------------ */
/* Run lifecycle                                                       */
/* ------------------------------------------------------------------ */

export async function createRun(input: {
  workflowId: string;
  triggerType: 'manual' | 'webhook' | 'scheduled' | 'database_event';
  triggeredBy: string | null;
  payload: Record<string, unknown>;
}): Promise<{ id: string; status: RunStatus }> {
  const data = await adminGraphql<{
    insert_workflow_runs_one: { id: string; status: RunStatus };
  }>(
    `mutation CreateRun($object: workflow_runs_insert_input!) {
       insert_workflow_runs_one(object: $object) { id status }
     }`,
    {
      object: {
        workflow_id: input.workflowId,
        trigger_type: input.triggerType,
        triggered_by: input.triggeredBy,
        input: input.payload,
        status: 'queued',
      },
    },
  );
  return data.insert_workflow_runs_one;
}

export async function claimRun(runId: string, token: string, leaseSeconds: number): Promise<boolean> {
  const data = await adminGraphql<{ claim_workflow_run: Array<{ id: string }> }>(
    `mutation Claim($runId: uuid!, $token: uuid!, $lease: Int!) {
       claim_workflow_run(args: { p_run: $runId, p_token: $token, p_lease_seconds: $lease }) { id }
     }`,
    { runId, token, lease: leaseSeconds },
  );
  return data.claim_workflow_run.length > 0;
}

export async function extendLease(runId: string, token: string, leaseSeconds: number): Promise<boolean> {
  const data = await adminGraphql<{ extend_workflow_run_lease: Array<{ id: string }> }>(
    `mutation Extend($runId: uuid!, $token: uuid!, $lease: Int!) {
       extend_workflow_run_lease(args: { p_run: $runId, p_token: $token, p_lease_seconds: $lease }) { id }
     }`,
    { runId, token, lease: leaseSeconds },
  );
  return data.extend_workflow_run_lease.length > 0;
}

export async function getRunForExecution(runId: string): Promise<RunForExecution | null> {
  const data = await adminGraphql<{ workflow_runs_by_pk: RunForExecution | null }>(
    `query RunForExecution($runId: uuid!) {
       workflow_runs_by_pk(id: $runId) {
         id
         org_id
         workflow_id
         status
         next_position
         input
         billable_calls
         workflow {
           id
           name
           is_active
           steps(order_by: { position: asc }) {
             id position name type config retry_limit timeout_ms
           }
         }
         step_runs(order_by: { position: asc }) {
           id position status step_type output
         }
       }
     }`,
    { runId },
  );
  return data.workflow_runs_by_pk;
}

export async function updateRun(runId: string, set: Record<string, unknown>): Promise<void> {
  await adminGraphql(
    `mutation UpdateRun($runId: uuid!, $set: workflow_runs_set_input!) {
       update_workflow_runs_by_pk(pk_columns: { id: $runId }, _set: $set) { id }
     }`,
    { runId, set },
  );
}

export async function incrementBillableCalls(runId: string, by = 1): Promise<void> {
  await adminGraphql(
    `mutation Bill($runId: uuid!, $by: Int!) {
       update_workflow_runs_by_pk(pk_columns: { id: $runId }, _inc: { billable_calls: $by }) { id }
     }`,
    { runId, by },
  );
}

/* ------------------------------------------------------------------ */
/* Step runs                                                           */
/* ------------------------------------------------------------------ */

export async function upsertStepRun(input: {
  runId: string;
  stepId: string;
  position: number;
  name: string;
  stepType: StepType;
  status: StepRunStatus;
  stepInput?: unknown;
}): Promise<{ id: string; attempt: number }> {
  const data = await adminGraphql<{
    insert_step_runs_one: { id: string; attempt: number };
  }>(
    `mutation UpsertStepRun($object: step_runs_insert_input!) {
       insert_step_runs_one(
         object: $object,
         on_conflict: {
           constraint: step_runs_workflow_run_id_position_key,
           update_columns: [status, input, started_at, workflow_step_id, name, step_type]
         }
       ) { id attempt }
     }`,
    {
      object: {
        workflow_run_id: input.runId,
        workflow_step_id: input.stepId,
        position: input.position,
        name: input.name,
        step_type: input.stepType,
        status: input.status,
        input: input.stepInput ?? null,
        started_at: new Date().toISOString(),
      },
    },
  );
  return data.insert_step_runs_one;
}

export async function updateStepRun(stepRunId: string, set: Record<string, unknown>): Promise<void> {
  await adminGraphql(
    `mutation UpdateStepRun($stepRunId: uuid!, $set: step_runs_set_input!) {
       update_step_runs_by_pk(pk_columns: { id: $stepRunId }, _set: $set) { id }
     }`,
    { stepRunId, set },
  );
}

export async function bumpStepAttempt(stepRunId: string): Promise<void> {
  await adminGraphql(
    `mutation BumpAttempt($stepRunId: uuid!) {
       update_step_runs_by_pk(pk_columns: { id: $stepRunId }, _inc: { attempt: 1 }) { id }
     }`,
    { stepRunId },
  );
}

export async function markStepsSkipped(runId: string, fromPosition: number, toPositionExclusive: number): Promise<void> {
  if (toPositionExclusive <= fromPosition) return;
  await adminGraphql(
    // Timestamps are sent as ISO strings, never as the text "now()". Postgres
    // accepts the special literal 'now' but not 'now()', so the latter fails
    // the timestamptz cast at insert time.
    `mutation SkipSteps($runId: uuid!, $from: Int!, $to: Int!, $at: timestamptz!) {
       update_step_runs(
         where: {
           workflow_run_id: { _eq: $runId },
           position: { _gte: $from, _lt: $to },
           status: { _eq: "pending" }
         },
         _set: { status: "skipped", finished_at: $at }
       ) { affected_rows }
     }`,
    { runId, from: fromPosition, to: toPositionExclusive, at: new Date().toISOString() },
  );
}

/**
 * Materialises a pending step_run for every step, once, when the run starts.
 * The UI then shows the full plan immediately instead of rows popping into
 * existence one at a time, and the subscription has something to stream.
 */
export async function seedStepRuns(runId: string, steps: WorkflowStep[]): Promise<void> {
  if (steps.length === 0) return;
  await adminGraphql(
    `mutation SeedStepRuns($objects: [step_runs_insert_input!]!) {
       insert_step_runs(
         objects: $objects,
         on_conflict: { constraint: step_runs_workflow_run_id_position_key, update_columns: [] }
       ) { affected_rows }
     }`,
    {
      objects: steps.map((step) => ({
        workflow_run_id: runId,
        workflow_step_id: step.id,
        position: step.position,
        name: step.name,
        step_type: step.type,
        status: 'pending',
      })),
    },
  );
}

/* ------------------------------------------------------------------ */
/* Side effects and audit                                              */
/* ------------------------------------------------------------------ */

export async function insertNotification(input: {
  orgId: string;
  runId: string;
  stepRunId: string;
  channel: 'slack' | 'email';
  target: string;
  subject: string | null;
  body: string;
}): Promise<{ id: string }> {
  const data = await adminGraphql<{ insert_notifications_one: { id: string } }>(
    `mutation Notify($object: notifications_insert_input!) {
       insert_notifications_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: input.orgId,
        workflow_run_id: input.runId,
        step_run_id: input.stepRunId,
        channel: input.channel,
        target: input.target,
        subject: input.subject,
        body: input.body,
      },
    },
  );
  return data.insert_notifications_one;
}

export async function insertWorkflowRecord(input: {
  orgId: string;
  runId: string;
  stepRunId: string;
  collection: string;
  payload: unknown;
}): Promise<{ id: string }> {
  const data = await adminGraphql<{ insert_workflow_records_one: { id: string } }>(
    `mutation Record($object: workflow_records_insert_input!) {
       insert_workflow_records_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: input.orgId,
        workflow_run_id: input.runId,
        step_run_id: input.stepRunId,
        collection: input.collection,
        payload: input.payload,
      },
    },
  );
  return data.insert_workflow_records_one;
}

export async function audit(input: {
  orgId: string | null;
  actorId: string | null;
  action: string;
  subjectId?: string | null;
  outcome: 'allowed' | 'denied' | 'error';
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await adminGraphql(
      `mutation Audit($object: audit_log_insert_input!) {
         insert_audit_log_one(object: $object) { id }
       }`,
      {
        object: {
          org_id: input.orgId,
          actor_id: input.actorId,
          action: input.action,
          subject_id: input.subjectId ?? null,
          outcome: input.outcome,
          detail: input.detail ?? {},
        },
      },
    );
  } catch {
    // Auditing must never be the reason a request fails.
  }
}

export async function getOrgSecrets(orgId: string, names: string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const data = await adminGraphql<{
    org_secrets: Array<{ name: string; ciphertext: string }>;
  }>(
    `query Secrets($orgId: uuid!, $names: [String!]!) {
       org_secrets(where: { org_id: { _eq: $orgId }, name: { _in: $names } }) {
         name ciphertext
       }
     }`,
    { orgId, names },
  );
  return Object.fromEntries(data.org_secrets.map((s) => [s.name, s.ciphertext]));
}
