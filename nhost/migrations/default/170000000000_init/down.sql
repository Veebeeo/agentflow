DROP VIEW IF EXISTS public.org_usage_current_period;

DROP FUNCTION IF EXISTS public.extend_workflow_run_lease(uuid, uuid, integer);

DROP FUNCTION IF EXISTS public.claim_workflow_run(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.release_org_quota(uuid, integer);
DROP FUNCTION IF EXISTS public.reserve_org_quota(uuid, integer);

DROP TABLE IF EXISTS public.audit_log;
DROP TABLE IF EXISTS public.org_secrets;
DROP TABLE IF EXISTS public.leads;
DROP TABLE IF EXISTS public.notifications;
DROP TABLE IF EXISTS public.workflow_records;
DROP TABLE IF EXISTS public.step_runs;
DROP TABLE IF EXISTS public.workflow_runs;
DROP TABLE IF EXISTS public.workflow_triggers;
DROP TABLE IF EXISTS public.workflow_steps;
DROP TABLE IF EXISTS public.workflows;
DROP TABLE IF EXISTS public.org_members;
DROP TABLE IF EXISTS public.organizations;

DROP TABLE IF EXISTS public.step_run_status;
DROP TABLE IF EXISTS public.run_status;
DROP TABLE IF EXISTS public.trigger_type;
DROP TABLE IF EXISTS public.step_type;
DROP TABLE IF EXISTS public.org_role;

DROP FUNCTION IF EXISTS public.guard_privileged_trigger();
DROP FUNCTION IF EXISTS public.guard_privileged_step();
DROP FUNCTION IF EXISTS public.workflow_runs_set_org();
DROP FUNCTION IF EXISTS public.org_members_keep_one_owner();
DROP FUNCTION IF EXISTS public.organizations_add_creator_as_owner();
DROP FUNCTION IF EXISTS public.has_org_role(uuid, uuid, text[]);
DROP FUNCTION IF EXISTS public.set_updated_at();
DROP FUNCTION IF EXISTS public.hasura_role();
DROP FUNCTION IF EXISTS public.hasura_user_id();
DROP FUNCTION IF EXISTS public.hasura_session();
