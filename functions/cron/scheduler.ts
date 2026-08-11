/**
 * Cron trigger: runs every minute and starts anything that is due.
 *
 * The claim is the interesting part. Each trigger is advanced with a
 * conditional update that only matches if next_run_at still holds the value we
 * read a moment ago. If two ticks overlap, the second one matches zero rows and
 * does nothing, so a workflow scheduled for 09:00 starts exactly once even if
 * the scheduler is slow or retried.
 */
import type { Request, Response } from 'express';
import parser from 'cron-parser';
import { requirePlatformSecret } from './../_lib/auth';
import { sendError } from './../_lib/errors';
import { adminGraphql } from './../_lib/hasura';
import { log } from './../_lib/log';
import { createRun, getQuotaSnapshot } from './../_lib/repo';

interface ScheduledTrigger {
  id: string;
  cron_expression: string | null;
  next_run_at: string | null;
  config: Record<string, unknown>;
  workflow: { id: string; org_id: string; is_active: boolean };
}

function nextOccurrence(expression: string, timezone: string, after: Date): Date | null {
  try {
    const interval = parser.parseExpression(expression, { currentDate: after, tz: timezone });
    return interval.next().toDate();
  } catch (error) {
    log.warn('Invalid cron expression', { expression, error: String(error) });
    return null;
  }
}

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);
    const now = new Date();

    const data = await adminGraphql<{ workflow_triggers: ScheduledTrigger[] }>(
      `query DueTriggers($now: timestamptz!) {
         workflow_triggers(
           where: {
             type: { _eq: "scheduled" },
             is_enabled: { _eq: true },
             workflow: { is_active: { _eq: true } },
             _or: [{ next_run_at: { _is_null: true } }, { next_run_at: { _lte: $now } }]
           },
           limit: 100
         ) {
           id cron_expression next_run_at config
           workflow { id org_id is_active }
         }
       }`,
      { now: now.toISOString() },
    );

    const started: string[] = [];

    for (const trigger of data.workflow_triggers) {
      if (!trigger.cron_expression) continue;
      const timezone = String(trigger.config.timezone ?? 'UTC');
      const next = nextOccurrence(trigger.cron_expression, timezone, now);
      if (!next) continue;

      // Claim: only succeeds if nobody advanced next_run_at since our read.
      const claim = await adminGraphql<{ update_workflow_triggers: { affected_rows: number } }>(
        // Hasura validates every branch of an _or even when only one can match,
        // and rejects a null bound to timestamptz _eq. A trigger seen for the
        // first time has a null next_run_at, so the two cases have to be two
        // different queries rather than one query with both branches.
        trigger.next_run_at === null
          ? `mutation ClaimNewTrigger($id: uuid!, $next: timestamptz!, $at: timestamptz!) {
               update_workflow_triggers(
                 where: { id: { _eq: $id }, next_run_at: { _is_null: true } },
                 _set: { next_run_at: $next, last_fired_at: $at }
               ) { affected_rows }
             }`
          : `mutation ClaimTrigger($id: uuid!, $expected: timestamptz!, $next: timestamptz!, $at: timestamptz!) {
               update_workflow_triggers(
                 where: { id: { _eq: $id }, next_run_at: { _eq: $expected } },
                 _set: { next_run_at: $next, last_fired_at: $at }
               ) { affected_rows }
             }`,
        {
          id: trigger.id,
          ...(trigger.next_run_at === null ? {} : { expected: trigger.next_run_at }),
          next: next.toISOString(),
          at: new Date().toISOString(),
        },
      );

      if (claim.update_workflow_triggers.affected_rows !== 1) {
        log.info('Another tick already claimed this trigger', { triggerId: trigger.id });
        continue;
      }

      // First sight of a trigger only sets the schedule. Firing immediately
      // would mean a workflow saved at 14:32 for "every night at 2am" runs now.
      if (trigger.next_run_at === null) continue;

      const quota = await getQuotaSnapshot(trigger.workflow.org_id);
      if (quota.remaining <= 0) {
        log.warn('Scheduled run skipped, quota exhausted', { orgId: trigger.workflow.org_id });
        continue;
      }

      const run = await createRun({
        workflowId: trigger.workflow.id,
        triggerType: 'scheduled',
        triggeredBy: null,
        payload: { scheduled_for: trigger.next_run_at, cron: trigger.cron_expression },
      });
      started.push(run.id);
    }

    if (started.length > 0) log.info('Scheduled runs created', { count: started.length });
    res.status(200).json({ evaluated: data.workflow_triggers.length, started: started.length });
  } catch (error) {
    sendError(res, error);
  }
}
