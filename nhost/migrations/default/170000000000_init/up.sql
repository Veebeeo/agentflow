CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION public.hasura_session()
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('hasura.user', true), '')::jsonb, '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.hasura_user_id()
RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := public.hasura_session() ->> 'x-hasura-user-id';
  IF v IS NULL OR v = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN others THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.hasura_role()
RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(public.hasura_session() ->> 'x-hasura-role', 'admin');
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- Enum tables. Real tables + FKs instead of CHECK constraints so that
-- Hasura exposes them as GraphQL enums and the values are queryable.
-- ---------------------------------------------------------------------
CREATE TABLE public.org_role (
  value       text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO public.org_role (value, description) VALUES
  ('owner',  'Full control over the organization, its workflows and its members'),
  ('editor', 'Can build workflows and start runs, cannot manage members'),
  ('viewer', 'Read-only access');

CREATE TABLE public.step_type (
  value       text PRIMARY KEY,
  description text NOT NULL,
  -- privileged types reach outside the sandbox and are owner-only
  is_privileged boolean NOT NULL DEFAULT false
);
INSERT INTO public.step_type (value, description, is_privileged) VALUES
  ('llm_call',           'Calls a large language model provider',            false),
  ('http_request',       'Calls an external HTTP API',                       false),
  ('db_write',           'Writes a record into application-owned tables',    true),
  ('notify',             'Sends an outbound Slack or email notification',    true),
  ('conditional_branch', 'Chooses the next step from the previous output',   false),
  ('approval_gate',      'Pauses the run until a human approves',            false);

CREATE TABLE public.trigger_type (
  value         text PRIMARY KEY,
  description   text NOT NULL,
  is_privileged boolean NOT NULL DEFAULT false
);
INSERT INTO public.trigger_type (value, description, is_privileged) VALUES
  ('manual',         'A user presses Run',                                false),
  ('webhook',        'An external system calls a signed inbound endpoint', true),
  ('scheduled',      'A cron expression evaluated by the scheduler',       false),
  ('database_event', 'A row change in a watched table',                    false);

CREATE TABLE public.run_status (
  value       text PRIMARY KEY,
  description text NOT NULL,
  is_terminal boolean NOT NULL DEFAULT false
);
INSERT INTO public.run_status (value, description, is_terminal) VALUES
  ('queued',    'Accepted, waiting for an executor',        false),
  ('running',   'An executor holds the lease',              false),
  ('paused',    'Stopped at an approval gate',              false),
  ('succeeded', 'All steps finished',                        true),
  ('failed',    'A step exhausted its retries or was denied', true),
  ('cancelled', 'Stopped by a user',                          true);

CREATE TABLE public.step_run_status (
  value       text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO public.step_run_status (value, description) VALUES
  ('pending',   'Not started'),
  ('running',   'In progress'),
  ('paused',    'Awaiting approval'),
  ('succeeded', 'Finished successfully'),
  ('failed',    'Finished with an error'),
  ('skipped',   'Bypassed by a conditional branch'),
  ('rejected',  'An approver denied it');

-- ---------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------
CREATE TABLE public.organizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  slug                  citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  quota_calls_allowed   integer NOT NULL DEFAULT 200 CHECK (quota_calls_allowed >= 0),
  quota_calls_used      integer NOT NULL DEFAULT 0   CHECK (quota_calls_used >= 0),
  quota_period_start    timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.org_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL REFERENCES public.org_role(value) ON UPDATE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX org_members_user_idx ON public.org_members (user_id);
CREATE INDEX org_members_org_role_idx ON public.org_members (org_id, role);
CREATE TRIGGER org_members_updated_at BEFORE UPDATE ON public.org_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Whoever creates an organization becomes its first owner, in the same
-- transaction. Without this an org could exist with nobody able to touch it.
CREATE OR REPLACE FUNCTION public.organizations_add_creator_as_owner()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE uid uuid := public.hasura_user_id();
BEGIN
  IF uid IS NOT NULL THEN
    INSERT INTO public.org_members (org_id, user_id, role)
    VALUES (NEW.id, uid, 'owner')
    ON CONFLICT (org_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_creator_owner AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.organizations_add_creator_as_owner();

-- An organization must never be left without an owner.
CREATE OR REPLACE FUNCTION public.org_members_keep_one_owner()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  remaining integer;
  losing_an_owner boolean;
BEGIN
  -- NEW is unassigned during DELETE, so it is never touched on that path.
  IF TG_OP = 'UPDATE' THEN
    losing_an_owner := (NEW.role IS DISTINCT FROM 'owner');
  ELSE
    losing_an_owner := true;
  END IF;

  IF NOT losing_an_owner THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO remaining
    FROM public.org_members
   WHERE org_id = OLD.org_id
     AND role = 'owner'
     AND id <> OLD.id;

  IF remaining = 0 THEN
    RAISE EXCEPTION 'organization % must keep at least one owner', OLD.org_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER org_members_last_owner
  BEFORE UPDATE OR DELETE ON public.org_members
  FOR EACH ROW WHEN (OLD.role = 'owner')
  EXECUTE FUNCTION public.org_members_keep_one_owner();

-- Reusable membership check for SQL-level guards.
CREATE OR REPLACE FUNCTION public.has_org_role(p_org uuid, p_user uuid, p_roles text[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members m
    WHERE m.org_id = p_org AND m.user_id = p_user AND m.role = ANY(p_roles)
  );
$$;

-- ---------------------------------------------------------------------
-- Workflow definition
-- ---------------------------------------------------------------------
CREATE TABLE public.workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_org_idx ON public.workflows (org_id, created_at DESC);
CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  position    integer NOT NULL CHECK (position >= 0),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  type        text NOT NULL REFERENCES public.step_type(value) ON UPDATE CASCADE,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  retry_limit integer NOT NULL DEFAULT 1 CHECK (retry_limit BETWEEN 0 AND 5),
  timeout_ms  integer NOT NULL DEFAULT 20000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- deferrable so a reorder can swap positions inside one transaction
  CONSTRAINT workflow_steps_position_unique UNIQUE (workflow_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX workflow_steps_workflow_idx ON public.workflow_steps (workflow_id, position);
CREATE TRIGGER workflow_steps_updated_at BEFORE UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.workflow_triggers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type            text NOT NULL REFERENCES public.trigger_type(value) ON UPDATE CASCADE,
  is_enabled      boolean NOT NULL DEFAULT true,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  -- webhook only: sha256 of the bearer token. The token itself is shown once
  -- at creation time and never stored.
  secret_hash     text,
  cron_expression text,
  next_run_at     timestamptz,
  last_fired_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_triggers_webhook_needs_secret
    CHECK (type <> 'webhook' OR secret_hash IS NOT NULL),
  CONSTRAINT workflow_triggers_cron_needs_expression
    CHECK (type <> 'scheduled' OR cron_expression IS NOT NULL)
);
CREATE INDEX workflow_triggers_workflow_idx ON public.workflow_triggers (workflow_id);
CREATE INDEX workflow_triggers_due_idx ON public.workflow_triggers (next_run_at)
  WHERE type = 'scheduled' AND is_enabled;
CREATE TRIGGER workflow_triggers_updated_at BEFORE UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Layer 2, enforced in the database.
-- Privileged step and trigger types require the owner role, whoever is asking.
-- The admin role (our own executor) is exempt; it never creates definitions
-- on a user's behalf without having checked first.
CREATE OR REPLACE FUNCTION public.guard_privileged_step()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid          uuid := public.hasura_user_id();
  caller_role  text := public.hasura_role();
  is_privileged boolean;
  v_org        uuid;
BEGIN
  IF caller_role = 'admin' AND uid IS NULL THEN
    RETURN NEW;  -- backend-initiated write
  END IF;

  SELECT st.is_privileged INTO is_privileged FROM public.step_type st WHERE st.value = NEW.type;
  IF NOT COALESCE(is_privileged, false) THEN
    RETURN NEW;
  END IF;

  SELECT w.org_id INTO v_org FROM public.workflows w WHERE w.id = NEW.workflow_id;
  IF uid IS NULL OR NOT public.has_org_role(v_org, uid, ARRAY['owner']) THEN
    RAISE EXCEPTION 'step type % requires the owner role', NEW.type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_steps_guard_privileged
  BEFORE INSERT OR UPDATE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.guard_privileged_step();

CREATE OR REPLACE FUNCTION public.guard_privileged_trigger()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  uid           uuid := public.hasura_user_id();
  caller_role   text := public.hasura_role();
  is_privileged boolean;
  v_org         uuid;
BEGIN
  IF caller_role = 'admin' AND uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tt.is_privileged INTO is_privileged FROM public.trigger_type tt WHERE tt.value = NEW.type;
  IF NOT COALESCE(is_privileged, false) THEN
    RETURN NEW;
  END IF;

  SELECT w.org_id INTO v_org FROM public.workflows w WHERE w.id = NEW.workflow_id;
  IF uid IS NULL OR NOT public.has_org_role(v_org, uid, ARRAY['owner']) THEN
    RAISE EXCEPTION 'trigger type % requires the owner role', NEW.type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_triggers_guard_privileged
  BEFORE INSERT OR UPDATE ON public.workflow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.guard_privileged_trigger();

-- ---------------------------------------------------------------------
-- Execution state
-- ---------------------------------------------------------------------
CREATE TABLE public.workflow_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  -- denormalised for cheap tenant filtering on the hot path; set by trigger,
  -- never by the caller
  org_id         uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'queued' REFERENCES public.run_status(value) ON UPDATE CASCADE,
  trigger_type   text NOT NULL REFERENCES public.trigger_type(value) ON UPDATE CASCADE,
  triggered_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,
  output         jsonb,
  error          text,
  next_position  integer NOT NULL DEFAULT 0,
  billable_calls integer NOT NULL DEFAULT 0,
  -- optimistic lease: only one executor may advance a run at a time
  lease_token    uuid,
  lease_expires_at timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_workflow_idx ON public.workflow_runs (workflow_id, created_at DESC);
CREATE INDEX workflow_runs_org_idx ON public.workflow_runs (org_id, created_at DESC);
CREATE INDEX workflow_runs_active_idx ON public.workflow_runs (status) WHERE status IN ('queued','running');
CREATE TRIGGER workflow_runs_updated_at BEFORE UPDATE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.workflow_runs_set_org()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT w.org_id INTO NEW.org_id FROM public.workflows w WHERE w.id = NEW.workflow_id;
  IF NEW.org_id IS NULL THEN
    RAISE EXCEPTION 'workflow % does not exist', NEW.workflow_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_runs_org_guard BEFORE INSERT ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.workflow_runs_set_org();

CREATE TABLE public.step_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id  uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  workflow_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  position         integer NOT NULL,
  name             text NOT NULL,
  step_type        text NOT NULL REFERENCES public.step_type(value) ON UPDATE CASCADE,
  status           text NOT NULL DEFAULT 'pending' REFERENCES public.step_run_status(value) ON UPDATE CASCADE,
  input            jsonb,
  output           jsonb,
  error            text,
  attempt          integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  approved_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  approval_note    text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, position)
);
CREATE INDEX step_runs_run_idx ON public.step_runs (workflow_run_id, position);
CREATE INDEX step_runs_awaiting_idx ON public.step_runs (status) WHERE status = 'paused';
CREATE TRIGGER step_runs_updated_at BEFORE UPDATE ON public.step_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------
-- Side-effect tables
-- ---------------------------------------------------------------------

-- Target of the db_write step type.
CREATE TABLE public.workflow_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  step_run_id     uuid REFERENCES public.step_runs(id) ON DELETE SET NULL,
  collection      text NOT NULL CHECK (collection ~ '^[a-z0-9_]{1,40}$'),
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_records_org_idx ON public.workflow_records (org_id, created_at DESC);

-- The notify step writes here; an event trigger delivers it. Keeping delivery
-- out of the executor means a slow Slack API cannot stall a run.
CREATE TABLE public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  step_run_id     uuid REFERENCES public.step_runs(id) ON DELETE SET NULL,
  channel         text NOT NULL CHECK (channel IN ('slack','email')),
  target          text NOT NULL,
  subject         text,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error           text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org_idx ON public.notifications (org_id, created_at DESC);
CREATE TRIGGER notifications_updated_at BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A watched business table, so the database_event trigger type has something
-- real to react to.
CREATE TABLE public.leads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email      citext NOT NULL,
  company    text,
  message    text NOT NULL,
  source     text NOT NULL DEFAULT 'web',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_org_idx ON public.leads (org_id, created_at DESC);

-- Org-scoped secrets referenced from step config as {{secrets.NAME}}.
-- No role except admin ever gets select on this table, so the ciphertext
-- is not reachable through the GraphQL API at all.
CREATE TABLE public.org_secrets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{1,48}$'),
  ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- Append-only audit of security-relevant decisions.
CREATE TABLE public.audit_log (
  id         bigserial PRIMARY KEY,
  org_id     uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  subject_id uuid,
  outcome    text NOT NULL CHECK (outcome IN ('allowed','denied','error')),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_idx ON public.audit_log (org_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Quota accounting
-- One statement per reservation. Two concurrent runs cannot both read
-- "199 of 200 used" and both proceed.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_org_quota(p_org uuid, p_amount integer)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE granted boolean;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'quota amount must be positive';
  END IF;

  -- roll the period forward first, if the month changed
  UPDATE public.organizations
     SET quota_calls_used = 0,
         quota_period_start = date_trunc('month', now())
   WHERE id = p_org
     AND quota_period_start < date_trunc('month', now());

  UPDATE public.organizations
     SET quota_calls_used = quota_calls_used + p_amount
   WHERE id = p_org
     AND quota_calls_used + p_amount <= quota_calls_allowed
  RETURNING true INTO granted;

  RETURN COALESCE(granted, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_org_quota(p_org uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE remaining integer;
BEGIN
  UPDATE public.organizations
     SET quota_calls_used = GREATEST(0, quota_calls_used - p_amount)
   WHERE id = p_org
  RETURNING quota_calls_used INTO remaining;
  RETURN COALESCE(remaining, 0);
END;
$$;

-- ---------------------------------------------------------------------
-- Run lease
-- Event triggers retry, schedulers overlap, users double-click. Exactly one
-- executor may hold a run, and a crashed executor's lease expires.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_workflow_run(
  p_run uuid, p_token uuid, p_lease_seconds integer DEFAULT 90
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed boolean;
BEGIN
  UPDATE public.workflow_runs
     SET status = 'running',
         lease_token = p_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         started_at = COALESCE(started_at, now())
   WHERE id = p_run
     AND (
           status = 'queued'
        OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))
     )
  RETURNING true INTO claimed;

  RETURN COALESCE(claimed, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.extend_workflow_run_lease(
  p_run uuid, p_token uuid, p_lease_seconds integer DEFAULT 90
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE ok boolean;
BEGIN
  UPDATE public.workflow_runs
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_run AND lease_token = p_token AND status = 'running'
  RETURNING true INTO ok;
  RETURN COALESCE(ok, false);
END;
$$;

-- ---------------------------------------------------------------------
-- Aggregation: org usage for the current period.
-- A view rather than a computed field, so Hasura can also aggregate over it.
-- ---------------------------------------------------------------------
CREATE VIEW public.org_usage_current_period AS
SELECT
  o.id                                                    AS org_id,
  o.quota_calls_allowed,
  o.quota_calls_used,
  GREATEST(o.quota_calls_allowed - o.quota_calls_used, 0)  AS quota_calls_remaining,
  o.quota_period_start,
  COUNT(r.id) FILTER (WHERE r.created_at >= o.quota_period_start)                          AS runs_started,
  COUNT(r.id) FILTER (WHERE r.status = 'succeeded' AND r.created_at >= o.quota_period_start) AS runs_succeeded,
  COUNT(r.id) FILTER (WHERE r.status = 'failed'    AND r.created_at >= o.quota_period_start) AS runs_failed,
  COUNT(r.id) FILTER (WHERE r.status = 'paused')                                            AS runs_awaiting_approval,
  COALESCE(
    ROUND(
      (AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)))
        FILTER (WHERE r.finished_at IS NOT NULL AND r.created_at >= o.quota_period_start))::numeric,
      2
    ),
    0
  )                                                                                          AS avg_run_seconds
FROM public.organizations o
LEFT JOIN public.workflow_runs r ON r.org_id = o.id
GROUP BY o.id, o.quota_calls_allowed, o.quota_calls_used, o.quota_period_start;

COMMENT ON VIEW public.org_usage_current_period IS
  'Per-organization usage for the current quota period. Exposed through Hasura with the same org scoping as the base tables.';
