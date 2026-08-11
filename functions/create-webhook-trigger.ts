/**
 * Action: createWebhookTrigger(workflow_id)
 *
 * Webhook triggers are owner-only and cannot be inserted through the GraphQL
 * table permission at all, because the row has to carry a secret the client
 * must not choose. The token is generated here, returned once, and stored only
 * as a SHA-256 hash. Losing it means minting a new one, which is the correct
 * trade: a credential a system can show you twice is a credential in a log
 * somewhere.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { actionPayload, requirePlatformSecret, requireUserId } from './_lib/auth';
import { badRequest, forbidden, notFound, sendError } from './_lib/errors';
import { adminGraphql } from './_lib/hasura';
import { audit, getWorkflowAccess } from './_lib/repo';

interface Input {
  workflow_id?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);
    const payload = actionPayload<Input>(req);
    const userId = requireUserId(payload);

    const workflowId = payload.input?.workflow_id;
    if (!workflowId || !UUID.test(workflowId)) throw badRequest('workflow_id must be a UUID');

    const access = await getWorkflowAccess(workflowId, userId);
    if (!access) throw notFound('Workflow not found');

    if (access.role !== 'owner') {
      await audit({
        orgId: access.orgId,
        actorId: userId,
        action: 'create_webhook_trigger',
        subjectId: workflowId,
        outcome: 'denied',
        detail: { reason: 'insufficient-role', role: access.role },
      });
      throw forbidden('Only owners can expose a workflow to the outside world');
    }

    const token = `wht_${randomBytes(32).toString('base64url')}`;
    const secretHash = createHash('sha256').update(token).digest('hex');

    const data = await adminGraphql<{ insert_workflow_triggers_one: { id: string } }>(
      `mutation CreateWebhookTrigger($object: workflow_triggers_insert_input!) {
         insert_workflow_triggers_one(object: $object) { id }
       }`,
      {
        object: {
          workflow_id: workflowId,
          type: 'webhook',
          is_enabled: true,
          secret_hash: secretHash,
          config: { created_by: userId },
        },
      },
    );

    await audit({
      orgId: access.orgId,
      actorId: userId,
      action: 'create_webhook_trigger',
      subjectId: data.insert_workflow_triggers_one.id,
      outcome: 'allowed',
      detail: { workflow_id: workflowId },
    });

    res.status(200).json({
      trigger_id: data.insert_workflow_triggers_one.id,
      endpoint: 'POST /v1/graphql  mutation { triggerWorkflowWebhook(workflow_id: ..., payload: ...) }',
      token,
    });
  } catch (error) {
    sendError(res, error);
  }
}
