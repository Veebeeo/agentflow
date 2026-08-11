/**
 * Admin-privileged GraphQL client, used by handlers after they have done their
 * own authorization. Admin access is a loaded gun: every query in here is
 * either explicitly scoped by org_id, or is called only after a membership
 * check has already passed.
 */
import { adminSecret, graphqlUrl, metadataUrl } from './env';
import { log } from './log';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

export async function adminGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  operationName?: string,
): Promise<T> {
  const res = await fetch(graphqlUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': adminSecret(),
    },
    body: JSON.stringify({ query, variables, operationName }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL transport error ${res.status}`);
  }

  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    log.error('GraphQL error', { errors: body.errors, operationName });
    throw new Error(body.errors[0]?.message ?? 'GraphQL error');
  }
  if (!body.data) throw new Error('GraphQL returned no data');
  return body.data;
}

/**
 * One-off scheduled events are how a run continues after an approval or after
 * an executor runs out of time. Hasura owns the delivery and the retries, so a
 * function that dies mid-flight does not strand the run.
 */
export async function scheduleOneOff(
  webhookUrl: string,
  payload: Record<string, unknown>,
  headers: Array<{ name: string; value: string }>,
  delayMs = 0,
  comment = 'agentflow-continuation',
): Promise<void> {
  const res = await fetch(metadataUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': adminSecret(),
    },
    body: JSON.stringify({
      type: 'create_scheduled_event',
      args: {
        webhook: webhookUrl,
        schedule_at: new Date(Date.now() + delayMs).toISOString(),
        payload,
        headers,
        retry_conf: {
          num_retries: 3,
          retry_interval_seconds: 10,
          timeout_seconds: 60,
          tolerance_seconds: 3600,
        },
        comment,
      },
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to schedule continuation: ${res.status} ${text}`);
  }
  // Hasura answers 200 for a GraphQL request posted to the wrong endpoint, so
  // a 200 alone does not mean the event was created. Check the body.
  if (text.includes('"errors"') || !text.includes('success')) {
    throw new Error(`Continuation not scheduled, unexpected response: ${text}`);
  }
}
