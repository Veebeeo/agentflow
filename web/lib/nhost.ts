'use client';

/**
 * One Nhost client for the whole browser session.
 *
 * Everything the app knows about the SDK surface lives in this file. If the SDK
 * changes shape between versions, this is the only place that needs editing.
 */
import { createClient, type NhostClient } from '@nhost/nhost-js';

function options() {
  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  const region = process.env.NEXT_PUBLIC_NHOST_REGION;

  // Explicit URLs win, which is how the local CLI stack is addressed.
  if (process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL) {
    return {
      authUrl: process.env.NEXT_PUBLIC_NHOST_AUTH_URL,
      graphqlUrl: process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL,
      storageUrl: process.env.NEXT_PUBLIC_NHOST_STORAGE_URL,
      functionsUrl: process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL,
    };
  }
  return { subdomain, region };
}

let client: NhostClient | null = null;

export function nhost(): NhostClient {
  if (!client) client = createClient(options());
  return client;
}

/** The websocket endpoint Hasura serves subscriptions on. */
export function graphqlWsUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL ??
    `https://${process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN}.graphql.${process.env.NEXT_PUBLIC_NHOST_REGION}.nhost.run/v1`;

  // The GraphQL endpoint is spelled differently in different environments:
  // Nhost Cloud serves it at /v1, the local stack at /v1/graphql. Whatever the
  // HTTP endpoint is, the socket lives at the same path, so use it unchanged
  // rather than guessing at a suffix.
  const normalized = base.replace(/\/+$/, '');
  return normalized.replace(/^http/, 'ws');
}

/** A token that is valid for at least another minute. */
export async function freshAccessToken(): Promise<string | null> {
  const client = nhost();
  const refreshed = await client.refreshSession(60).catch(() => null);
  return refreshed?.accessToken ?? client.getUserSession()?.accessToken ?? null;
}
