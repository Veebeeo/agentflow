/**
 * Action: triggerWorkflowRun(workflow_id, input)
 *
 * This is the front door. It does four things and then gets out of the way:
 *   1. proves the request came from our Hasura instance
 *   2. re-derives the caller's role from the database, not from the request
 *   3. checks the organization has quota left before creating anything
 *   4. creates the run and returns
 *
 * It deliberately does not execute the workflow. An event trigger on the new
 * row does that, so a two minute LLM chain never sits inside the caller's
 * mutation waiting to time out.
 */
import type { Request, Response } from 'express';
import { actionPayload, requirePlatformSecret, requireUserId } from './_lib/auth';
import { badRequest, forbidden, notFound, quotaExceeded, sendError } from './_lib/errors';
import { log } from './_lib/log';
import { audit, createRun, getQuotaSnapshot, getWorkflowAccess } from './_lib/repo';

interface Input {
  workflow_id?: string;
  input?: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);
    const payload = actionPayload<Input>(req);
    const userId = requireUserId(payload);

    const workflowId = payload.input?.workflow_id;
    if (!workflowId || !UUID.test(workflowId)) {
      throw badRequest('workflow_id must be a UUID');
    }

    const runInput = payload.input?.input ?? {};
    if (typeof runInput !== 'object' || Array.isArray(runInput)) {
      throw badRequest('input must be an object');
    }
    if (JSON.stringify(runInput).length > 32_000) {
      throw badRequest('input exceeds 32KB');
    }

    // Layer 1, re-checked server side. Hasura's permission on the action only
    // proves the caller is signed in; it says nothing about this workflow.
    const access = await getWorkflowAccess(workflowId, userId);
    if (!access) {
      // Same response whether the workflow belongs to another organization or
      // does not exist. Guessing an id tells an outsider nothing.
      await audit({
        orgId: null,
        actorId: userId,
        action: 'trigger_workflow_run',
        subjectId: workflowId,
        outcome: 'denied',
        detail: { reason: 'not-a-member-or-missing' },
      });
      throw notFound('Workflow not found');
    }

    if (access.role === 'viewer') {
      await audit({
        orgId: access.orgId,
        actorId: userId,
        action: 'trigger_workflow_run',
        subjectId: workflowId,
        outcome: 'denied',
        detail: { reason: 'viewer-cannot-trigger', role: access.role },
      });
      throw forbidden('Viewers cannot start runs');
    }

    if (!access.isActive) throw badRequest('This workflow is paused');
    if (access.stepCount === 0) throw badRequest('Add at least one step before running');

    const quota = await getQuotaSnapshot(access.orgId);
    if (quota.remaining <= 0) {
      await audit({
        orgId: access.orgId,
        actorId: userId,
        action: 'trigger_workflow_run',
        subjectId: workflowId,
        outcome: 'denied',
        detail: { reason: 'quota-exhausted', ...quota },
      });
      throw quotaExceeded(`Quota exhausted: ${quota.used} of ${quota.allowed} calls used this period`);
    }

    const run = await createRun({
      workflowId,
      triggerType: 'manual',
      triggeredBy: userId,
      payload: runInput as Record<string, unknown>,
    });

    await audit({
      orgId: access.orgId,
      actorId: userId,
      action: 'trigger_workflow_run',
      subjectId: run.id,
      outcome: 'allowed',
      detail: { role: access.role, workflow_id: workflowId },
    });
    log.info('Run created', { runId: run.id, workflowId, userId });

    res.status(200).json({ workflow_run_id: run.id, status: run.status });
  } catch (error) {
    sendError(res, error);
  }
}
