/**
 * conditional_branch: picks the next step from the previous step's output.
 *
 * Two rules keep this safe and analysable:
 *   - comparisons are a fixed set of operators, never a user-supplied
 *     expression, so no evaluator is reachable from tenant config
 *   - branch targets must be strictly greater than the current position, so a
 *     workflow is a DAG that always terminates. Loops would need a separate
 *     step type with its own iteration cap.
 */
import { type StepContext, type StepResult, StepError } from './types';

type Operator =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'starts_with'
  | 'matches'
  | 'gt'
  | 'lt'
  | 'is_empty'
  | 'is_true';

const OPERATORS: Operator[] = [
  'contains', 'not_contains', 'equals', 'not_equals', 'starts_with',
  'matches', 'gt', 'lt', 'is_empty', 'is_true',
];

function evaluate(operator: Operator, sourceRaw: string, expected: string, caseSensitive: boolean): boolean {
  const source = caseSensitive ? sourceRaw : sourceRaw.toLowerCase();
  const value = caseSensitive ? expected : expected.toLowerCase();

  switch (operator) {
    case 'contains': return source.includes(value);
    case 'not_contains': return !source.includes(value);
    case 'equals': return source.trim() === value.trim();
    case 'not_equals': return source.trim() !== value.trim();
    case 'starts_with': return source.trimStart().startsWith(value);
    case 'matches': return safeRegexTest(expected, sourceRaw, caseSensitive);
    case 'gt': return Number(sourceRaw) > Number(expected);
    case 'lt': return Number(sourceRaw) < Number(expected);
    case 'is_empty': return sourceRaw.trim() === '';
    case 'is_true': return ['true', 'yes', '1'].includes(sourceRaw.trim().toLowerCase());
    default: return false;
  }
}

/**
 * Tenant-supplied patterns are a denial-of-service risk through catastrophic
 * backtracking, so the pattern is length-capped and the input truncated.
 * A worker-thread timeout would be the fuller answer if this saw real traffic.
 */
function safeRegexTest(pattern: string, input: string, caseSensitive: boolean): boolean {
  if (pattern.length > 200) {
    throw new StepError('Regular expression pattern is too long', false);
  }
  try {
    return new RegExp(pattern, caseSensitive ? '' : 'i').test(input.slice(0, 10_000));
  } catch {
    throw new StepError('Invalid regular expression', false);
  }
}

export function conditionalBranch(ctx: StepContext): StepResult {
  const operator = String(ctx.config.operator ?? 'contains') as Operator;
  if (!OPERATORS.includes(operator)) {
    throw new StepError(`Unsupported operator "${operator}"`, false);
  }

  // `source` arrives already resolved, e.g. "{{steps.0.output.text}}" has
  // become the model's actual answer.
  const source = String(ctx.config.source ?? '');
  const expected = String(ctx.config.value ?? '');
  const caseSensitive = Boolean(ctx.config.case_sensitive ?? false);

  const result = evaluate(operator, source, expected, caseSensitive);
  const target = result ? ctx.config.on_true : ctx.config.on_false;
  const current = ctx.step.position;

  let nextPosition: number | undefined;
  if (target !== undefined && target !== null) {
    const parsed = Number(target);
    if (!Number.isInteger(parsed)) {
      throw new StepError('Branch targets must be integer step positions', false);
    }
    if (parsed <= current) {
      throw new StepError(
        `Branch target ${parsed} must be after the branch step at position ${current}`,
        false,
      );
    }
    nextPosition = parsed;
  }

  return {
    output: {
      matched: result,
      operator,
      // Truncated so a large upstream body does not get copied into every
      // later template context.
      source_preview: source.slice(0, 500),
      compared_to: expected,
      next_position: nextPosition ?? current + 1,
    },
    nextPosition,
  };
}
