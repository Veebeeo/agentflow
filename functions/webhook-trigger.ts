/**
 * Action: triggerWorkflowWebhook(workflow_id, payload)  [role: public]
 *
 * The inbound endpoint external systems call. There is no Nhost session here,
 * so authentication is the bearer token issued by createWebhookTrigger,
 * compared against the stored hash in constant time.
 *
 * Notice what this handler does not do: it never looks at session_variables,
 * and it never trusts the payload to say which organization it belongs to. The
 * token identifies the trigger, the trigger identifies the workflow, and the
 * workflow identifies the tenant. Authorization flows one way.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { actionPayload, requirePlatformSecret } from './_lib/auth';
import { badRequest, quotaExceeded, sendError, unauthorized } from './_lib/errors';
import { adminGraphql } from './_lib/hasura';
import { log } from './_lib/log';
import { audit, createRun, getQuotaSnapshot } from './_lib/repo';

interface Input {
  workflow_id?: string;
  payload?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bearerToken(req: Request): string | null {
  // Hasura parses the Authorization header as a JWT before an action handler
  // ever runs, so a webhook token sent that way is rejected upstream with a
  // JWT decode error. A dedicated header routes around the platform's auth
  // without weakening anything: the token is still verified here, in constant
  // time, against a stored hash.
  const direct = req.get('x-agentflow-webhook-token');
  if (direct && direct.trim()) return direct.trim();

  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);
    const body = actionPayload<Input>(req);

    const workflowId = body.input?.workflow_id;
    if (!workflowId || !UUID.test(workflowId)) throw badRequest('workflow_id must be a UUID');

    const token = bearerToken(req);
    if (!token) throw unauthorized('Missing bearer token');

    const providedHash = createHash('sha256').update(token).digest('hex');

    const data = await adminGraphql<{
      workflow_triggers: Array<{
        id: string;
        secret_hash: string | null;
        workflow: { id: string; org_id: string; is_active: boolean };
      }>;
    }>(
      `query WebhookTriggers($workflowId: uuid!) {
         workflow_triggers(
           where: {
             workflow_id: { _eq: $workflowId },
             type: { _eq: "webhook" },
             is_enabled: { _eq: true }
           }
         ) {
           id
           secret_hash
           workflow { id org_id is_active }
         }
       }`,
      { workflowId },
    );

    // Compare against every enabled trigger so tokens can be rotated without
    // downtime: mint the new one, switch the caller over, delete the old one.
    const matched = data.workflow_triggers.find(
      (trigger) => trigger.secret_hash && hashesMatch(trigger.secret_hash, providedHash),
    );

    if (!matched) {
      await audit({
        orgId: null,
        actorId: null,
        action: 'webhook_trigger',
        subjectId: workflowId,
        outcome: 'denied',
        detail: { reason: 'bad-token' },
      });
      // Same message whether the workflow is missing, has no webhook, or the
      // token is wrong.
      throw unauthorized('Invalid webhook credentials');
    }

    if (!matched.workflow.is_active) throw badRequest('This workflow is paused');

    const quota = await getQuotaSnapshot(matched.workflow.org_id);
    if (quota.remaining <= 0) {
      throw quotaExceeded('Quota exhausted for this period');
    }

    const payload = body.input?.payload ?? {};
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw badRequest('payload must be an object');
    }
    if (JSON.stringify(payload).length > 32_000) throw badRequest('payload exceeds 32KB');

    const run = await createRun({
      workflowId,
      triggerType: 'webhook',
      triggeredBy: null,
      payload: payload as Record<string, unknown>,
    });

    await adminGraphql(
      `mutation TouchTrigger($id: uuid!, $at: timestamptz!) {
         update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { last_fired_at: $at }) { id }
       }`,
      { id: matched.id, at: new Date().toISOString() },
    );

    await audit({
      orgId: matched.workflow.org_id,
      actorId: null,
      action: 'webhook_trigger',
      subjectId: run.id,
      outcome: 'allowed',
      detail: { trigger_id: matched.id },
    });
    log.info('Webhook run created', { runId: run.id, workflowId });

    res.status(200).json({ workflow_run_id: run.id, status: run.status });
  } catch (error) {
    sendError(res, error);
  }
}
