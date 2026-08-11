/**
 * llm_call: a real request to a chat completions API.
 *
 * The provider endpoints are fixed constants, not tenant input, so this does
 * not go through the SSRF-guarded client. With no key configured it falls back
 * to a stub that returns a deterministic answer after an artificial delay, and
 * marks the output stubbed so nothing downstream mistakes it for a real call.
 */
import { optional } from '../env';
import { statusIsRetryable } from '../retry';
import { type StepContext, type StepResult, StepError, requireString, optionalString } from './types';

const ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

const STUB_DELAY_MS = 900;

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export async function llmCall(ctx: StepContext): Promise<StepResult> {
  const prompt = requireString(ctx.config, 'prompt');
  const system = optionalString(ctx.config, 'system') ?? 'You are a precise assistant inside an automated workflow. Answer concisely.';
  const maxTokens = Math.min(Number(ctx.config.max_tokens ?? 512), 2048);
  const temperature = Math.max(0, Math.min(Number(ctx.config.temperature ?? 0.2), 2));

  const provider = optional('LLM_PROVIDER', 'groq').toLowerCase();
  const apiKey = optional('LLM_API_KEY');
  const model = optional('LLM_MODEL', 'llama-3.3-70b-versatile');

  if (!apiKey) {
    await new Promise((resolve) => setTimeout(resolve, STUB_DELAY_MS));
    return {
      output: {
        text: stubAnswer(prompt),
        model: 'stub',
        provider: 'stub',
        stubbed: true,
        note: `No LLM_API_KEY configured. Returned a deterministic answer after an artificial ${STUB_DELAY_MS}ms delay.`,
        latency_ms: STUB_DELAY_MS,
      },
      billable: 1,
    };
  }

  const endpoint = ENDPOINTS[provider];
  if (!endpoint) {
    throw new StepError(`Unsupported LLM_PROVIDER "${provider}"`, false);
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(ctx.step.timeout_ms, 30_000));

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new StepError(
        `LLM provider returned ${response.status}: ${text.slice(0, 300)}`,
        statusIsRetryable(response.status),
      );
    }

    let parsed: ChatCompletion;
    try {
      parsed = JSON.parse(text) as ChatCompletion;
    } catch {
      throw new StepError('LLM provider returned a non-JSON body', true);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new StepError('LLM response contained no message content', true);
    }

    return {
      output: {
        text: content.trim(),
        model: parsed.model ?? model,
        provider,
        finish_reason: parsed.choices?.[0]?.finish_reason ?? null,
        usage: parsed.usage ?? null,
        latency_ms: Date.now() - started,
      },
      billable: 1,
    };
  } catch (error) {
    if (error instanceof StepError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new StepError(`LLM call timed out after ${ctx.step.timeout_ms}ms`, true);
    }
    throw new StepError(`LLM call failed: ${String(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the demo branchable without a key: urgency words in, urgency out. */
function stubAnswer(prompt: string): string {
  const urgent = /urgent|outage|down|critical|asap|breach|refund|angry/i.test(prompt);
  return urgent
    ? 'PRIORITY: high. The message describes a time-sensitive problem that needs a human today.'
    : 'PRIORITY: low. The message is routine and can be handled in the normal queue.';
}
