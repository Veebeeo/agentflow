'use client';

/**
 * Live step-by-step progress.
 *
 * Hasura authorises the socket with the same permissions it applies to queries,
 * so a subscription on a run in another organization is not an error, it is an
 * empty stream. The token is fetched fresh on every connect, and the socket is
 * torn down and rebuilt when the session changes, because a websocket opened
 * with an expired token stays dead silently.
 */
import { createClient as createWsClient, type Client } from 'graphql-ws';
import { freshAccessToken, graphqlWsUrl } from './nhost';

export interface Subscription {
  unsubscribe: () => void;
}

export function subscribe<T>(
  query: string,
  variables: Record<string, unknown>,
  handlers: {
    onData: (data: T) => void;
    onError?: (error: unknown) => void;
    onStatus?: (status: 'connecting' | 'live' | 'closed') => void;
  },
): Subscription {
  let client: Client | null = null;
  let disposed = false;

  const start = () => {
    handlers.onStatus?.('connecting');

    client = createWsClient({
      url: graphqlWsUrl(),
      lazy: false,
      retryAttempts: 8,
      shouldRetry: () => !disposed,
      connectionParams: async () => {
        const token = await freshAccessToken();
        return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
      },
      on: {
        connected: () => handlers.onStatus?.('live'),
        closed: () => handlers.onStatus?.('closed'),
      },
    });

    client.subscribe<T>(
      { query, variables },
      {
        next: (result) => {
          if (result.data) handlers.onData(result.data);
        },
        error: (error) => handlers.onError?.(error),
        complete: () => handlers.onStatus?.('closed'),
      },
    );
  };

  start();

  return {
    unsubscribe: () => {
      disposed = true;
      client?.dispose();
      client = null;
    },
  };
}
