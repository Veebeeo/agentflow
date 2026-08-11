/**
 * http_request: a call to any external API, through the SSRF-guarded client.
 */
import { safeRequest, OutboundError } from '../safe-fetch';
import { statusIsRetryable } from '../retry';
import { type StepContext, type StepResult, StepError, requireString } from './types';

export async function httpRequest(ctx: StepContext): Promise<StepResult> {
  const url = requireString(ctx.config, 'url');
  const method = String(ctx.config.method ?? 'GET').toUpperCase();

  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw new StepError(`HTTP method ${method} is not allowed`, false);
  }

  const headers = (ctx.config.headers ?? {}) as Record<string, string>;
  const rawBody = ctx.config.body;
  const body =
    rawBody === undefined || rawBody === null
      ? undefined
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody);

  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }

  try {
    const response = await safeRequest(url, {
      method,
      headers,
      body,
      timeoutMs: ctx.step.timeout_ms,
    });

    if (statusIsRetryable(response.status)) {
      throw new StepError(`Upstream returned ${response.status}`, true);
    }
    if (response.status >= 400) {
      throw new StepError(`Upstream returned ${response.status}`, false);
    }

    let json: unknown = null;
    const contentType = response.headers['content-type'] ?? '';
    if (contentType.includes('json') && !response.truncated) {
      try {
        json = JSON.parse(response.body);
      } catch {
        json = null;
      }
    }

    return {
      output: {
        status: response.status,
        json,
        // Raw text is capped so a large response cannot bloat every later
        // template context that references this step.
        text: json === null ? response.body.slice(0, 4000) : undefined,
        truncated: response.truncated,
        latency_ms: response.durationMs,
      },
      billable: 1,
    };
  } catch (error) {
    if (error instanceof StepError) throw error;
    if (error instanceof OutboundError) {
      throw new StepError(error.message, error.retryable);
    }
    throw new StepError(`HTTP request failed: ${String(error)}`, true);
  }
}
