/**
 * Envelope encryption for org_secrets.
 *
 * Step config can reference {{secrets.STRIPE_KEY}}. The plaintext exists only
 * inside an executor invocation: it is decrypted just before the outbound call
 * and never written back into step_runs.input.
 *
 * AES-256-GCM gives confidentiality and integrity together, and the org id is
 * bound in as additional authenticated data, so ciphertext copied from one
 * tenant's row into another's fails to decrypt rather than silently working.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { required } from './env';

const VERSION = 'v1';

function key(): Buffer {
  const raw = Buffer.from(required('AGENTFLOW_SECRETS_KEY'), 'base64');
  if (raw.length !== 32) {
    throw new Error('AGENTFLOW_SECRETS_KEY must decode to exactly 32 bytes');
  }
  return raw;
}

export function encryptSecret(plaintext: string, orgId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(orgId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(encoded: string, orgId: string): string {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognised secret format');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(orgId, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
