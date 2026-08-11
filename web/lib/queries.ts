/**
 * Every GraphQL document the app sends.
 *
 * Written out in full rather than generated, so the shape of each request is
 * reviewable next to the permission rules it relies on.
 */

/** Memberships drive the whole UI: which orgs exist for me, and as what role. */
export const MY_MEMBERSHIPS = /* GraphQL */ `
  query MyMemberships {
    org_members(order_by: { created_at: asc }) {
      id
      role
      org_id
      organization {
        id
        name
        slug
        usage {
          quota_calls_allowed
          quota_calls_used
          quota_calls_remaining
          runs_started
          runs_succeeded
          runs_failed
          runs_awaiting_approval
          avg_run_seconds
        }
      }
    }
  }
`;

/**
 * The required read: an org's workflows with steps, triggers and the status of
 * the most recent run. One round trip, and the org filter is applied by Hasura
 * rather than by the argument, which is only a narrowing convenience.
 */
export const ORG_WORKFLOWS = /* GraphQL */ `
  query OrgWorkflows($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      is_active
      org_id
      created_at
      steps(order_by: { position: asc }) {
        id
        position
        name
        type
        config
        retry_limit
        timeout_ms
      }
      triggers(order_by: { created_at: asc }) {
        id
        type
        is_enabled
        config
        cron_expression
        next_run_at
        last_fired_at
      }
      runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
  }
`;

export const WORKFLOW_DETAIL = /* GraphQL */ `
  query WorkflowDetail($workflowId: uuid!) {
    workflows_by_pk(id: $workflowId) {
      id
      name
      description
      is_active
      org_id
      created_at
      steps(order_by: { position: asc }) {
        id
        position
        name
        type
        config
        retry_limit
        timeout_ms
      }
      triggers(order_by: { created_at: asc }) {
        id
        type
        is_enabled
        config
        cron_expression
        next_run_at
        last_fired_at
      }
      runs(order_by: { created_at: desc }, limit: 10) {
        id
        status
        trigger_type
        created_at
        finished_at
      }
    }
  }
`;

export const CREATE_ORGANIZATION = /* GraphQL */ `
  mutation CreateOrganization($name: String!, $slug: citext!) {
    insert_organizations_one(object: { name: $name, slug: $slug }) {
      id
      name
      slug
    }
  }
`;

export const CREATE_WORKFLOW = /* GraphQL */ `
  mutation CreateWorkflow($orgId: uuid!, $name: String!, $description: String) {
    insert_workflows_one(object: { org_id: $orgId, name: $name, description: $description }) {
      id
    }
  }
`;

/**
 * Save the whole step list in one mutation: delete what is gone, then insert
 * the current set. Both statements share a transaction, so a failure part-way
 * leaves the previous definition intact rather than half a workflow.
 */
export const SAVE_STEPS = /* GraphQL */ `
  mutation SaveSteps($workflowId: uuid!, $steps: [workflow_steps_insert_input!]!) {
    delete_workflow_steps(where: { workflow_id: { _eq: $workflowId } }) {
      affected_rows
    }
    insert_workflow_steps(objects: $steps) {
      affected_rows
    }
  }
`;

export const ADD_TRIGGER = /* GraphQL */ `
  mutation AddTrigger($object: workflow_triggers_insert_input!) {
    insert_workflow_triggers_one(object: $object) {
      id
      type
    }
  }
`;

export const DELETE_TRIGGER = /* GraphQL */ `
  mutation DeleteTrigger($id: uuid!) {
    delete_workflow_triggers_by_pk(id: $id) {
      id
    }
  }
`;

export const TRIGGER_RUN = /* GraphQL */ `
  mutation TriggerRun($workflowId: uuid!, $input: jsonb) {
    triggerWorkflowRun(workflow_id: $workflowId, input: $input) {
      workflow_run_id
      status
    }
  }
`;

export const APPROVE_STEP = /* GraphQL */ `
  mutation ApproveStep($stepRunId: uuid!, $decision: String!, $note: String) {
    approveStep(step_run_id: $stepRunId, decision: $decision, note: $note) {
      step_run_id
      workflow_run_id
      status
    }
  }
`;

export const CREATE_WEBHOOK_TRIGGER = /* GraphQL */ `
  mutation CreateWebhookTrigger($workflowId: uuid!) {
    createWebhookTrigger(workflow_id: $workflowId) {
      trigger_id
      endpoint
      token
    }
  }
`;

export const CREATE_LEAD = /* GraphQL */ `
  mutation CreateLead($orgId: uuid!, $email: citext!, $company: String, $message: String!) {
    insert_leads_one(
      object: { org_id: $orgId, email: $email, company: $company, message: $message, source: "demo" }
    ) {
      id
    }
  }
`;

export const RUN_DETAIL = /* GraphQL */ `
  query RunDetail($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      trigger_type
      error
      billable_calls
      input
      output
      created_at
      started_at
      finished_at
      workflow {
        id
        name
        org_id
      }
    }
  }
`;

/** The live one. Filtered to a single run, which is what the brief asks for. */
export const STEP_RUNS_SUBSCRIPTION = /* GraphQL */ `
  subscription StepRuns($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { position: asc }) {
      id
      position
      name
      step_type
      status
      attempt
      input
      output
      error
      approved_by
      approved_at
      approval_note
      started_at
      finished_at
    }
  }
`;

/** Run header, also live, so the paused and finished states arrive without a refresh. */
export const RUN_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription RunStatus($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      error
      billable_calls
      started_at
      finished_at
    }
  }
`;

export const ORG_RUNS = /* GraphQL */ `
  query OrgRuns($orgId: uuid!) {
    workflow_runs(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }, limit: 15) {
      id
      status
      trigger_type
      created_at
      finished_at
      workflow {
        id
        name
      }
    }
  }
`;
