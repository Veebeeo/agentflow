export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return '';
  const end = to ? new Date(to).getTime() : Date.now();
  const ms = end - new Date(from).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function pad(position: number): string {
  return String(position + 1).padStart(2, '0');
}

export function pretty(value: unknown): string {
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

export const STEP_LABELS: Record<string, string> = {
  llm_call: 'Ask a model',
  http_request: 'Call an API',
  db_write: 'Save a record',
  notify: 'Send an alert',
  conditional_branch: 'Branch on a result',
  approval_gate: 'Wait for approval',
};

export const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Run button',
  webhook: 'Inbound webhook',
  scheduled: 'Schedule',
  database_event: 'New lead row',
};
