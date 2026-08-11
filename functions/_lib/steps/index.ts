import { conditionalBranch } from './conditional-branch';
import { dbWrite } from './db-write';
import { httpRequest } from './http-request';
import { llmCall } from './llm-call';
import { notify } from './notify';
import { type StepContext, type StepResult, StepError } from './types';
import type { StepType } from '../repo';

export { StepError };
export type { StepContext, StepResult };

/**
 * approval_gate is absent on purpose. It is not an operation the executor
 * performs; it is a state the run enters, so the engine handles it directly.
 */
const HANDLERS: Partial<Record<StepType, (ctx: StepContext) => Promise<StepResult> | StepResult>> = {
  llm_call: llmCall,
  http_request: httpRequest,
  db_write: dbWrite,
  notify,
  conditional_branch: conditionalBranch,
};

export async function runStep(ctx: StepContext): Promise<StepResult> {
  const handler = HANDLERS[ctx.step.type];
  if (!handler) {
    throw new StepError(`Step type ${ctx.step.type} has no executor`, false);
  }
  return handler(ctx);
}

/** Which step types consume quota. Used for the pre-flight check at trigger time. */
export const BILLABLE_STEP_TYPES: StepType[] = ['llm_call', 'http_request'];
