/**
 * Request authentication for function handlers.
 *
 * Two separate things are checked and they must not be confused:
 *   - is this request really from our Hasura instance (shared secret)
 *   - who is the end user (session variables Hasura signed off on)
 *
 * The user identity always comes from `session_variables`, never from the
 * action's input. A client can put any workflow_id it likes in the body; it
 * cannot forge x-hasura-user-id, because Hasura derives that from the JWT.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { functionsSecret } from './env';
import { forbidden, unauthorized } from './errors';

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against itself so the timing profile does not depend on length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Every handler calls this first. Functions are public URLs on the internet. */
export function requirePlatformSecret(req: Request): void {
  const provided = req.get('x-agentflow-secret') ?? '';
  if (!provided || !constantTimeEquals(provided, functionsSecret())) {
    throw forbidden('Invalid platform secret');
  }
}

export interface SessionVariables {
  'x-hasura-user-id'?: string;
  'x-hasura-role'?: string;
  [key: string]: string | undefined;
}

export interface ActionPayload<TInput> {
  action: { name: string };
  input: TInput;
  session_variables: SessionVariables;
  request_query?: string;
}

export function actionPayload<TInput>(req: Request): ActionPayload<TInput> {
  const body = req.body as ActionPayload<TInput> | undefined;
  if (!body || typeof body !== 'object' || !body.action) {
    throw unauthorized('Not an action invocation');
  }
  return body;
}

/** The signed-in user id, or a 401. */
export function requireUserId(payload: ActionPayload<unknown>): string {
  const role = payload.session_variables?.['x-hasura-role'];
  const userId = payload.session_variables?.['x-hasura-user-id'];
  if (!userId || role === 'anonymous' || role === 'public') {
    throw unauthorized();
  }
  return userId;
}
