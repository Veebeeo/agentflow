/**
 * notify: queues an outbound alert.
 *
 * The step only writes a row. An event trigger on notifications delivers it,
 * which is what the brief asks for and is also the right shape: delivery is
 * retried by Hasura on its own schedule, and a Slack outage cannot hold a lease
 * open or fail an otherwise successful run.
 */
import { insertNotification } from '../repo';
import { type StepContext, type StepResult, StepError, requireString } from './types';

export async function notify(ctx: StepContext): Promise<StepResult> {
  const channel = String(ctx.config.channel ?? 'slack');
  if (channel !== 'slack' && channel !== 'email') {
    throw new StepError('channel must be "slack" or "email"', false);
  }

  const target = requireString(ctx.config, 'target');
  const body = requireString(ctx.config, 'body');
  const subject = typeof ctx.config.subject === 'string' ? ctx.config.subject : null;

  if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    throw new StepError('target must be an email address for the email channel', false);
  }
  if (body.length > 4000) {
    throw new StepError('body exceeds 4000 characters', false);
  }

  const notification = await insertNotification({
    orgId: ctx.orgId,
    runId: ctx.runId,
    stepRunId: ctx.stepRunId,
    channel,
    target,
    subject,
    body,
  });

  return { output: { notification_id: notification.id, channel, target, queued: true } };
}
