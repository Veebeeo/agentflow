-- Hasura can only track functions that return a table, so these return the row
-- they touched instead of a boolean. Zero rows means the operation did not
-- apply, which carries exactly the same information. Every statement stays a
-- single atomic UPDATE, which is the property that matters.

DROP FUNCTION IF EXISTS public.reserve_org_quota(uuid, integer);
DROP FUNCTION IF EXISTS public.release_org_quota(uuid, integer);
DROP FUNCTION IF EXISTS public.claim_workflow_run(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.extend_workflow_run_lease(uuid, uuid, integer);

CREATE FUNCTION public.reserve_org_quota(p_org uuid, p_amount integer)
RETURNS SETOF public.organizations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'quota amount must be positive';
  END IF;

  UPDATE public.organizations
     SET quota_calls_used = 0,
         quota_period_start = date_trunc('month', now())
   WHERE id = p_org
     AND quota_period_start < date_trunc('month', now());

  RETURN QUERY
  UPDATE public.organizations
     SET quota_calls_used = quota_calls_used + p_amount
   WHERE id = p_org
     AND quota_calls_used + p_amount <= quota_calls_allowed
  RETURNING *;
END;
$$;

CREATE FUNCTION public.release_org_quota(p_org uuid, p_amount integer)
RETURNS SETOF public.organizations
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.organizations
     SET quota_calls_used = GREATEST(0, quota_calls_used - p_amount)
   WHERE id = p_org
  RETURNING *;
END;
$$;

CREATE FUNCTION public.claim_workflow_run(
  p_run uuid, p_token uuid, p_lease_seconds integer DEFAULT 90
)
RETURNS SETOF public.workflow_runs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
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
  RETURNING *;
END;
$$;

CREATE FUNCTION public.extend_workflow_run_lease(
  p_run uuid, p_token uuid, p_lease_seconds integer DEFAULT 90
)
RETURNS SETOF public.workflow_runs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.workflow_runs
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE id = p_run AND lease_token = p_token AND status = 'running'
  RETURNING *;
END;
$$;