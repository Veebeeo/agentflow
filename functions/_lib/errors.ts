/**
 * Hasura turns a JSON body of {message, extensions} with a 4xx status into a
 * GraphQL error on the client. Everything the client sees is deliberate:
 * internal failures collapse to a generic message so that stack traces and
 * table names never leave the backend.
 */
import type { Response } from 'express';
import { log } from './log';

export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string) => new AppError(m, 400, 'bad-request');
export const unauthorized = (m = 'Not authenticated') => new AppError(m, 401, 'unauthorized');
export const forbidden = (m = 'Not allowed') => new AppError(m, 403, 'forbidden');
export const notFound = (m = 'Not found') => new AppError(m, 404, 'not-found');
export const conflict = (m: string) => new AppError(m, 409, 'conflict');
export const quotaExceeded = (m: string) => new AppError(m, 429, 'quota-exceeded');

/**
 * Deliberately vague on 404 vs 403. Telling an outsider "this exists but is not
 * yours" is itself a leak, so a workflow in another organization looks exactly
 * like a workflow that does not exist.
 */
export function sendError(res: Response, err: unknown) {
  if (err instanceof AppError) {
    res.status(err.status).json({
      message: err.message,
      extensions: { code: err.code },
    });
    return;
  }
  log.error('Unhandled handler failure', { error: String(err) });
  res.status(500).json({
    message: 'Internal error',
    extensions: { code: 'internal' },
  });
}
