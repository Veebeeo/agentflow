/**
 * The executor endpoint.
 *
 * Called by the workflow_run_created event trigger, and by the one-off
 * scheduled events the engine creates for approvals and continuations. It
 * accepts both payload shapes and is idempotent: a duplicate delivery fails to
 * take the lease and returns 200 so Hasura stops retrying.
 */
import type { Request, Response } from 'express';
import { requirePlatformSecret } from './_lib/auth';
import { sendError } from './_lib/errors';
import { advanceRun } from './_lib/engine';
import { log } from './_lib/log';

interface EventPayload {
  event?: { data?: { new?: { id?: string } } };
  run_id?: string;
}

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);

    const body = (req.body ?? {}) as EventPayload;
    const runId = body.run_id ?? body.event?.data?.new?.id;

    if (!runId) {
      // 200 rather than 400: a malformed delivery will never become valid, and
      // returning an error just makes Hasura retry it three more times.
      log.warn('Executor invoked without a run id', { body });
      res.status(200).json({ ignored: true });
      return;
    }

    const result = await advanceRun(runId);
    res.status(200).json({ run_id: runId, ...result });
  } catch (error) {
    sendError(res, error);
  }
}
