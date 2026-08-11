import type { TemplateContext } from '../template';
import type { WorkflowStep } from '../repo';

export interface StepContext {
  runId: string;
  orgId: string;
  stepRunId: string;
  step: WorkflowStep;
  /** Config with {{...}} placeholders already resolved. */
  config: Record<string, unknown>;
  template: TemplateContext;
}

export interface StepResult {
  output: unknown;
  /**
   * Absolute position to continue from. Undefined means "the next step".
   * Only conditional_branch sets it, and only ever forwards.
   */
  nextPosition?: number;
  /** Calls to bill against the organization's quota. */
  billable?: number;
}

export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'StepError';
  }
}

export function requireString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StepError(`Step config field "${key}" must be a non-empty string`, false);
  }
  return value;
}

export function optionalString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
