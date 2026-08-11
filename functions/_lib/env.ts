/**
 * Environment access. Reading process.env inline everywhere makes it easy to
 * ship a handler that silently does nothing because a variable was missing, so
 * everything goes through here and required values fail loudly at first use.
 */

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

/** Hasura's GraphQL endpoint, as seen from inside the platform network. */
export function graphqlUrl(): string {
  return (
    process.env.NHOST_GRAPHQL_URL ||
    process.env.HASURA_GRAPHQL_URL ||
    'http://graphql:8080/v1/graphql'
  );
}

/** Metadata endpoint, derived from the GraphQL one so there is one source of truth. */
export function metadataUrl(): string {
  return graphqlUrl().replace(/\/v1\/graphql\/?$/, '/v1/metadata');
}

export function adminSecret(): string {
  return required('NHOST_ADMIN_SECRET');
}

/** Shared secret Hasura sends on every action, event and cron invocation. */
export function functionsSecret(): string {
  return required('AGENTFLOW_FUNCTIONS_SECRET');
}

export function functionsBaseUrl(): string {
  return required('AGENTFLOW_FUNCTIONS_URL').replace(/\/$/, '');
}

export const config = {
  /** How long one executor invocation may run before it hands off. */
  executionBudgetMs: 35_000,
  /** Lease held on a run while an executor advances it. */
  leaseSeconds: 90,
  /** Hard ceiling on any single outbound request. */
  maxOutboundTimeoutMs: 30_000,
  /** Response body cap for http_request and llm_call. */
  maxResponseBytes: 256 * 1024,
  /** Maximum steps a single workflow may contain. */
  maxStepsPerWorkflow: 50,
};
