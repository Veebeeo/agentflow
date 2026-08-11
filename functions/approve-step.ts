/**
 * Action: approveStep(step_run_id, decision, note)
 *
 * Layer 2, the part that cannot be a row permission.
 *
 * A database permission answers "may this user read or write this row". The
 * question here is different: "may this user, right now, release a run that is
 * sitting at position 4 of an execution that is already in flight". That
 * depends on run state and on the approver's role in the run's organization,
 * and it has to be decided in one place that also owns what happens next. So
 * the handler checks it, writes the decision, and resumes the run.
 */
import type { Request, Response } from 'express';
import { actionPayload, requirePlatformSecret, requireUserId } from './_lib/auth';
import { badRequest, conflict, forbidden, notFound, sendError } from './_lib/errors';
import { scheduleAdvance } from './_lib/engine';
import { log } from './_lib/log';
import { audit, getStepRunForApproval, updateRun, updateStepRun } from './_lib/repo';

interface Input {
  step_run_id?: string;
  decision?: string;
  note?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);
    const payload = actionPayload<Input>(req);
    const userId = requireUserId(payload);

    const stepRunId = payload.input?.step_run_id;
    if (!stepRunId || !UUID.test(stepRunId)) throw badRequest('step_run_id must be a UUID');

    const decision = payload.input?.decision ?? 'approve';
    if (decision !== 'approve' && decision !== 'reject') {
      throw badRequest('decision must be "approve" or "reject"');
    }

    const note = (payload.input?.note ?? '').slice(0, 500) || null;

    const gate = await getStepRunForApproval(stepRunId, userId);
    if (!gate) {
      await audit({
        orgId: null,
        actorId: userId,
        action: 'approve_step',
        subjectId: stepRunId,
        outcome: 'denied',
        detail: { reason: 'not-a-member-or-missing' },
      });
      throw notFound('Approval not found');
    }

    // Role check. A viewer in the right organization is still refused, and so
    // is an owner from a different organization: getStepRunForApproval only
    // returns a role for a membership row that actually exists.
    if (gate.role !== 'owner' && gate.role !== 'editor') {
      await audit({
        orgId: gate.orgId,
        actorId: userId,
        action: 'approve_step',
        subjectId: stepRunId,
        outcome: 'denied',
        detail: { reason: 'insufficient-role', role: gate.role },
      });
      throw forbidden('Only owners and editors can decide an approval');
    }

    // State check. Without this, two approvers racing on the same gate would
    // both resume the run and it would execute the next step twice.
    if (gate.stepStatus !== 'paused' || gate.runStatus !== 'paused') {
      throw conflict('This approval has already been decided');
    }

    const now = new Date().toISOString();

    if (decision === 'reject') {
      await updateStepRun(stepRunId, {
        status: 'rejected',
        approved_by: userId,
        approved_at: now,
        approval_note: note,
        finished_at: now,
        output: { decision: 'reject' },
      });
      await updateRun(gate.runId, {
        status: 'failed',
        finished_at: now,
        error: 'Approval rejected',
        lease_token: null,
        lease_expires_at: null,
      });
      await audit({
        orgId: gate.orgId,
        actorId: userId,
        action: 'approve_step',
        subjectId: stepRunId,
        outcome: 'allowed',
        detail: { decision: 'reject', role: gate.role },
      });
      res.status(200).json({ step_run_id: stepRunId, workflow_run_id: gate.runId, status: 'rejected' });
      return;
    }

    await updateStepRun(stepRunId, {
      status: 'succeeded',
      approved_by: userId,
      approved_at: now,
      approval_note: note,
      finished_at: now,
      output: { decision: 'approve', approved_by: userId },
    });

    // Back to queued at the next position. The executor picks it up through the
    // same path a fresh run takes, so there is one resume mechanism, not two.
    await updateRun(gate.runId, {
      status: 'queued',
      next_position: gate.position + 1,
      lease_token: null,
      lease_expires_at: null,
    });
    await scheduleAdvance(gate.runId, 0);

    await audit({
      orgId: gate.orgId,
      actorId: userId,
      action: 'approve_step',
      subjectId: stepRunId,
      outcome: 'allowed',
      detail: { decision: 'approve', role: gate.role },
    });
    log.info('Approval granted, run resuming', { runId: gate.runId, stepRunId, userId });

    res.status(200).json({ step_run_id: stepRunId, workflow_run_id: gate.runId, status: 'approved' });
  } catch (error) {
    sendError(res, error);
  }
}
