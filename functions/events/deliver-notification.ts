/**
 * Event trigger: a notify step queued a notification.
 *
 * Delivery lives here rather than in the step so that a slow or broken Slack
 * endpoint cannot hold a run's lease open. Hasura retries this webhook on its
 * own schedule, and the row records the outcome either way.
 *
 * With no SLACK_WEBHOOK_URL configured it records a dry run instead of
 * pretending to have sent something.
 */
import type { Request, Response } from 'express';
import { requirePlatformSecret } from './../_lib/auth';
import { sendError } from './../_lib/errors';
import { optional } from './../_lib/env';
import { adminGraphql } from './../_lib/hasura';
import { log } from './../_lib/log';
import { safeRequest } from './../_lib/safe-fetch';

interface NotificationRow {
  id: string;
  channel: 'slack' | 'email';
  target: string;
  subject: string | null;
  body: string;
  status: string;
}

async function markSent(id: string, error: string | null, note: string) {
  await adminGraphql(
    `mutation MarkNotification($id: uuid!, $set: notifications_set_input!) {
       update_notifications_by_pk(pk_columns: { id: $id }, _set: $set) { id }
     }`,
    {
      id,
      set: {
        status: error ? 'failed' : 'sent',
        error,
        sent_at: error ? null : new Date().toISOString(),
      },
    },
  );
  log.info('Notification processed', { id, note, failed: Boolean(error) });
}

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);

    const row = (req.body?.event?.data?.new ?? null) as NotificationRow | null;
    if (!row?.id) {
      res.status(200).json({ ignored: true });
      return;
    }
    if (row.status !== 'pending') {
      res.status(200).json({ ignored: true, reason: 'already-processed' });
      return;
    }

    const slackUrl = optional('SLACK_WEBHOOK_URL');

    if (row.channel === 'slack' && slackUrl) {
      const text = row.subject ? `*${row.subject}*\n${row.body}` : row.body;
      const response = await safeRequest(slackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, channel: row.target }),
        timeoutMs: 10_000,
      });
      const failed = response.status >= 400 ? `Slack returned ${response.status}` : null;
      await markSent(row.id, failed, 'slack');
      // A 4xx from Slack will not fix itself, so do not ask Hasura to retry it.
      res.status(200).json({ delivered: !failed });
      return;
    }

    await markSent(
      row.id,
      null,
      row.channel === 'email'
        ? 'email delivery not wired up, recorded as dry run'
        : 'no SLACK_WEBHOOK_URL, recorded as dry run',
    );
    res.status(200).json({ delivered: false, dry_run: true });
  } catch (error) {
    sendError(res, error);
  }
}
