/**
 * Event trigger: a row landed in `leads`.
 *
 * This is the database_event trigger type. Every enabled workflow in that
 * organization whose trigger config watches this table gets a run, with the new
 * row as the run input. Nothing here is user-initiated, so there is no role
 * check: the organization is read from the row itself.
 */
import type { Request, Response } from 'express';
import { requirePlatformSecret } from './../_lib/auth';
import { sendError } from './../_lib/errors';
import { adminGraphql } from './../_lib/hasura';
import { log } from './../_lib/log';
import { audit, createRun, getQuotaSnapshot } from './../_lib/repo';

interface LeadRow {
  id: string;
  org_id: string;
  email: string;
  company: string | null;
  message: string;
  source: string;
}

interface HasuraEvent {
  event?: { op?: string; data?: { new?: LeadRow | null } };
  table?: { name?: string; schema?: string };
}

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);

    const body = (req.body ?? {}) as HasuraEvent;
    const row = body.event?.data?.new;
    if (!row?.org_id) {
      res.status(200).json({ ignored: true });
      return;
    }

    const tableName = body.table?.name ?? 'leads';

    const data = await adminGraphql<{
      workflow_triggers: Array<{
        id: string;
        config: Record<string, unknown>;
        workflow: { id: string; is_active: boolean; org_id: string };
      }>;
    }>(
      `query EventTriggers($orgId: uuid!) {
         workflow_triggers(
           where: {
             type: { _eq: "database_event" },
             is_enabled: { _eq: true },
             workflow: { org_id: { _eq: $orgId }, is_active: { _eq: true } }
           }
         ) {
           id
           config
           workflow { id is_active org_id }
         }
       }`,
      { orgId: row.org_id },
    );

    const matching = data.workflow_triggers.filter(
      (trigger) => String(trigger.config.table ?? 'leads') === tableName,
    );

    if (matching.length === 0) {
      res.status(200).json({ started: 0 });
      return;
    }

    // One quota check for the batch. A single row should not be able to start
    // fifty runs against an organization that has three calls left.
    const quota = await getQuotaSnapshot(row.org_id);
    if (quota.remaining <= 0) {
      log.warn('Skipping event-triggered runs, quota exhausted', { orgId: row.org_id });
      res.status(200).json({ started: 0, reason: 'quota-exhausted' });
      return;
    }

    const started: string[] = [];
    for (const trigger of matching) {
      const run = await createRun({
        workflowId: trigger.workflow.id,
        triggerType: 'database_event',
        triggeredBy: null,
        payload: { source_table: tableName, row },
      });
      started.push(run.id);
    }

    await audit({
      orgId: row.org_id,
      actorId: null,
      action: 'database_event_trigger',
      subjectId: row.id,
      outcome: 'allowed',
      detail: { table: tableName, runs: started.length },
    });
    log.info('Event-triggered runs created', { orgId: row.org_id, count: started.length });

    res.status(200).json({ started: started.length, run_ids: started });
  } catch (error) {
    sendError(res, error);
  }
}
