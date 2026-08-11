/**
 *
 * Exists to prove two things before any real logic depends on them:
 * that Hasura can reach this container, and that the shared secret
 * matches on both sides.
 */
import type { Request, Response } from 'express';
import { requirePlatformSecret } from './_lib/auth';
import { sendError } from './_lib/errors';
import { adminGraphql } from './_lib/hasura';

export default async function handler(req: Request, res: Response) {
  try {
    requirePlatformSecret(req);

    const data = await adminGraphql<{
      organizations_aggregate: { aggregate: { count: number } };
    }>(`query { organizations_aggregate { aggregate { count } } }`, {});

    res.status(200).json({
      ok: true,
      now: new Date().toISOString(),
      organizations: data.organizations_aggregate.aggregate.count,
    });
  } catch (err) {
    sendError(res, err);
  }
}