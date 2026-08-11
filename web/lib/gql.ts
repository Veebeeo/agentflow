'use client';

/**
 * Thin GraphQL helper.
 *
 * Errors are surfaced rather than swallowed: a permission denial from Hasura is
 * information the person needs, not a blank screen. Notably, most of this app's
 * cross-tenant protection shows up as *empty results* rather than errors, which
 * is the correct behaviour for a row-level filter.
 */
import { nhost } from './nhost';

export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await nhost().graphql.request<T>({ query, variables });
  const errors = response.body?.errors;

  if (errors?.length) {
    const first = errors[0];
    throw new GraphQLRequestError(
      first?.message ?? 'Request failed',
      (first?.extensions as { code?: string } | undefined)?.code,
    );
  }
  if (!response.body?.data) {
    throw new GraphQLRequestError('Request returned no data');
  }
  return response.body.data;
}
