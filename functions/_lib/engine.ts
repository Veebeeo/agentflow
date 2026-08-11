/**
 * The workflow engine.
 *
 * Shape of the thing: `advanceRun` is not "run the workflow". It is "move this
 * run forward as far as you safely can, then leave it in a state some other
 * invocation can pick up". That distinction is what makes approval gates,
 * function timeouts and crashed executors all the same problem with one
 * solution.
 *
 * Invariants:
 *   - exactly one executor advances a run at a time, enforced by a database
 *     lease rather than by hoping event triggers do not overlap
 *   - every state change is written before the next step begins, so the live
 *     subscription is always looking at the truth, not at a buffer
 *   - a step that runs out of its retry budget fails the run rather than being
 *     skipped, because silently continuing past a failed side effect is worse
 *     than stopping
 *   - quota is reserved before a billable call, not counted after it
 */
import { randomUUID } from 'node:crypto';
import { config } from './env';
import { log } from './log';
import { scheduleOneOff } from './hasura';
import { functionsBaseUrl, functionsSecret } from './env';
import { decryptSecret } from './crypto';
import { redactSecretValues, referencedSecrets, renderValue, type TemplateContext } from './template';
import { withRetry } from './retry';
import { runStep, StepError, type StepContext } from './steps';
import {
  bumpStepAttempt,
  claimRun,
  extendLease,
  getOrgSecrets,
  getRunForExecution,
  incrementBillableCalls,
  markStepsSkipped,
  releaseQuota,
  reserveQuota,
  seedStepRuns,
  updateRun,
  updateStepRun,
  upsertStepRun,
  type RunForExecution,
  type WorkflowStep,
} from './repo';

const BILLABLE = new Set(['llm_call', 'http_request']);

/** Asks Hasura to call the executor again for this run. */
export async function scheduleAdvance(runId: string, delayMs = 0): Promise<void> {
  await scheduleOneOff(
    `${functionsBaseUrl()}/execute-run`,
    { source: 'continuation', run_id: runId },
    [{ name: 'x-agentflow-secret', value: functionsSecret() }],
    delayMs,
    `agentflow advance ${runId}`,
  );
}

function buildTemplateContext(run: RunForExecution, secrets: Record<string, string>): TemplateContext {
  const steps: TemplateContext['steps'] = {};
  for (const stepRun of run.step_runs) {
    steps[String(stepRun.position)] = { output: stepRun.output, status: stepRun.status };
  }
  return {
    run: { id: run.id, input: run.input ?? {} },
    steps,
    secrets,
    now: new Date().toISOString(),
  };
}

/** Decrypts only the secrets this step actually names. */
async function resolveSecrets(orgId: string, stepConfig: unknown): Promise<Record<string, string>> {
  const names = [...referencedSecrets(stepConfig)];
  if (names.length === 0) return {};

  const rows = await getOrgSecrets(orgId, names);
  const resolved: Record<string, string> = {};
  for (const [name, ciphertext] of Object.entries(rows)) {
    try {
      resolved[name] = decryptSecret(ciphertext, orgId);
    } catch (error) {
      log.error('Secret failed to decrypt', { orgId, name, error: String(error) });
    }
  }
  return resolved;
}

function findStepAt(steps: WorkflowStep[], position: number): WorkflowStep | undefined {
  // Positions may be sparse after edits, so take the first step at or after
  // the target rather than assuming position === array index.
  return steps.find((step) => step.position >= position);
}

async function finish(
  run: RunForExecution,
  status: 'succeeded' | 'failed',
  detail: { output?: unknown; error?: string },
): Promise<void> {
  await updateRun(run.id, {
    status,
    finished_at: new Date().toISOString(),
    lease_token: null,
    lease_expires_at: null,
    output: detail.output ?? null,
    error: detail.error ?? null,
  });
  log.info('Run finished', { runId: run.id, status });
}

/**
 * Advance one run. Safe to call more than once concurrently: all but one caller
 * will fail to take the lease and return immediately.
 */
export async function advanceRun(runId: string): Promise<{ outcome: string }> {
  const leaseToken = randomUUID();
  const claimed = await claimRun(runId, leaseToken, config.leaseSeconds);
  if (!claimed) {
    // Either another executor holds it, or it is paused or already finished.
    log.info('Run not claimable, leaving it alone', { runId });
    return { outcome: 'not-claimable' };
  }

  const loaded = await getRunForExecution(runId);
  if (!loaded) {
    log.error('Claimed a run that does not exist', { runId });
    return { outcome: 'missing' };
  }
  // Declared non-nullable so the reassignments below stay narrowed inside the
  // step closures.
  let run: RunForExecution = loaded;

  if (!run.workflow.is_active) {
    await finish(run, 'failed', { error: 'Workflow is not active' });
    return { outcome: 'inactive' };
  }

  await seedStepRuns(run.id, run.workflow.steps);
  const deadline = Date.now() + config.executionBudgetMs;

  // Re-read so the seeded pending rows are in the context.
  run = (await getRunForExecution(runId)) ?? run;

  while (true) {
    const step = findStepAt(run.workflow.steps, run.next_position);

    if (!step) {
      const last = [...run.step_runs].reverse().find((s) => s.status === 'succeeded');
      await finish(run, 'succeeded', { output: last?.output ?? null });
      return { outcome: 'succeeded' };
    }

    if (Date.now() > deadline) {
      // Out of time. Release the lease and let Hasura call us back, rather than
      // risk the platform killing the invocation mid-step.
      await updateRun(run.id, { status: 'queued', lease_token: null, lease_expires_at: null });
      await scheduleAdvance(run.id, 1_000);
      log.info('Handing off to a continuation', { runId, position: step.position });
      return { outcome: 'continued' };
    }

    await extendLease(run.id, leaseToken, config.leaseSeconds);

    /* ---------------- approval gate: stop, do not execute --------------- */
    if (step.type === 'approval_gate') {
      const stepRun = await upsertStepRun({
        runId: run.id,
        stepId: step.id,
        position: step.position,
        name: step.name,
        stepType: step.type,
        status: 'paused',
        stepInput: { instructions: step.config.instructions ?? null },
      });
      await updateRun(run.id, {
        status: 'paused',
        lease_token: null,
        lease_expires_at: null,
      });
      log.info('Run paused for approval', { runId, position: step.position, stepRunId: stepRun.id });
      return { outcome: 'paused' };
    }

    /* ---------------- ordinary step ------------------------------------- */
    const secrets = await resolveSecrets(run.org_id, step.config);
    const template = buildTemplateContext(run, secrets);
    const resolvedConfig = renderValue(step.config, template);

    const stepRun = await upsertStepRun({
      runId: run.id,
      stepId: step.id,
      position: step.position,
      name: step.name,
      stepType: step.type,
      status: 'running',
      // Secret values are stripped before anything touches the database.
      stepInput: redactSecretValues(resolvedConfig, secrets),
    });

    const ctx: StepContext = {
      runId: run.id,
      orgId: run.org_id,
      stepRunId: stepRun.id,
      step,
      config: resolvedConfig,
      template,
    };

    const billable = BILLABLE.has(step.type);
    let reservedThisStep = 0;

    try {
      const result = await withRetry(
        async () => {
          if (billable) {
            const granted = await reserveQuota(run.org_id, 1);
            if (!granted) {
              throw new StepError('Organization quota exhausted for this period', false);
            }
            reservedThisStep += 1;
          }

          try {
            return await runStep(ctx);
          } catch (error) {
            // A failed attempt still consumed provider capacity in most cases,
            // but a request that never left the box did not: refund only when
            // the failure is local.
            if (billable && error instanceof StepError && !error.retryable) {
              await releaseQuota(run.org_id, 1);
              reservedThisStep -= 1;
            }
            throw error;
          }
        },
        {
          attempts: step.retry_limit + 1,
          onAttempt: async (attempt, error) => {
            await bumpStepAttempt(stepRun.id);
            log.warn('Step attempt failed', {
              runId: run.id,
              position: step.position,
              attempt,
              error: String(error),
            });
          },
        },
      );

      if (reservedThisStep > 0) {
        await incrementBillableCalls(run.id, reservedThisStep);
      }

      await updateStepRun(stepRun.id, {
        status: 'succeeded',
        output: result.output ?? null,
        finished_at: new Date().toISOString(),
        error: null,
      });

      const nextPosition = result.nextPosition ?? step.position + 1;
      if (result.nextPosition !== undefined && result.nextPosition > step.position + 1) {
        await markStepsSkipped(run.id, step.position + 1, result.nextPosition);
      }
      await updateRun(run.id, { next_position: nextPosition });

      run = (await getRunForExecution(runId)) ?? run;
      continue;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateStepRun(stepRun.id, {
        status: 'failed',
        error: message.slice(0, 2000),
        finished_at: new Date().toISOString(),
      });
      if (reservedThisStep > 0) {
        await incrementBillableCalls(run.id, reservedThisStep);
      }
      await finish(run, 'failed', {
        error: `Step ${step.position} (${step.name}) failed: ${message}`.slice(0, 2000),
      });
      log.error('Run failed', { runId, position: step.position, error: message });
      return { outcome: 'failed' };
    }
  }
}
