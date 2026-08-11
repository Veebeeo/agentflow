/**
 * db_write: persists a result into application-owned tables.
 *
 * Privileged, owner-only at creation time. The org id is taken from the run,
 * never from config, so a step cannot write into another tenant's rows even if
 * someone hand-crafts the JSON.
 */
import { insertWorkflowRecord } from '../repo';
import { type StepContext, type StepResult, StepError } from './types';

export async function dbWrite(ctx: StepContext): Promise<StepResult> {
  const collection = String(ctx.config.collection ?? '').trim();
  if (!/^[a-z0-9_]{1,40}$/.test(collection)) {
    throw new StepError('collection must be lower_snake_case, 1 to 40 characters', false);
  }

  const payload = ctx.config.payload;
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    throw new StepError('payload must be an object', false);
  }

  const serialized = JSON.stringify(payload);
  if (serialized.length > 64_000) {
    throw new StepError('payload exceeds 64KB', false);
  }

  const record = await insertWorkflowRecord({
    orgId: ctx.orgId,
    runId: ctx.runId,
    stepRunId: ctx.stepRunId,
    collection,
    payload,
  });

  return { output: { record_id: record.id, collection, bytes: serialized.length } };
}
