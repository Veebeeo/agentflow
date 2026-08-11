/**
 * Outbound HTTP for user-controlled URLs.
 *
 * An http_request step lets a tenant name any URL they like, and this code runs
 * inside the platform network next to Postgres, Hasura and the cloud metadata
 * service. A plain fetch() here is a server-side request forgery hole, so:
 *
 *   - only http and https, and https unless the host is explicitly allowlisted
 *   - DNS is resolved first and every returned address is checked against the
 *     private, loopback, link-local, CGNAT and unique-local ranges
 *   - the connection is then pinned to the address that was validated, using
 *     the socket-level lookup hook, which closes the DNS rebinding window
 *     between "we checked" and "we connected"
 *   - redirects are followed manually so each hop is validated the same way
 *   - responses are capped, so a tenant cannot exhaust memory by pointing a
 *     step at a multi-gigabyte file
 *   - hop-by-hop and identity headers from step config are dropped
 */
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { URL } from 'node:url';
import { config, optional } from './env';

export interface SafeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
  finalUrl: string;
}

export class OutboundError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OutboundError';
  }
}

/** Headers a caller may never set: they either lie about identity or break framing. */
const BLOCKED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'x-agentflow-secret',
  'x-hasura-admin-secret',
]);

function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // private
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true;             // protocol assignments
    if (a >= 224) return true;                         // multicast and reserved
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80')) return true;                      // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('ff')) return true;                        // multicast
    // IPv4-mapped, e.g. ::ffff:169.254.169.254
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;
}

function allowlist(): string[] {
  return optional('HTTP_ALLOWED_HOSTS')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostIsAllowlisted(hostname: string): boolean {
  const list = allowlist();
  if (list.length === 0) return false;
  const host = hostname.toLowerCase();
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

async function resolveAndValidate(hostname: string): Promise<string[]> {
  // A literal IP never goes to DNS.
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new OutboundError(`Address ${hostname} is not routable from here`, false);
    }
    return [hostname];
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new OutboundError(`Could not resolve ${hostname}`, true);
  }
  if (records.length === 0) {
    throw new OutboundError(`Could not resolve ${hostname}`, true);
  }
  // Every answer must be public. One private address in the set is enough to
  // reject: otherwise a round-robin record could be used to slip through.
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new OutboundError(`${hostname} resolves to a private address`, false);
    }
  }
  return records.map((r) => r.address);
}

function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundError('Malformed URL', false);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundError(`Protocol ${url.protocol} is not allowed`, false);
  }
  if (url.protocol === 'http:' && !hostIsAllowlisted(url.hostname)) {
    throw new OutboundError('Plain http is only allowed for allowlisted hosts', false);
  }
  const list = allowlist();
  if (list.length > 0 && !hostIsAllowlisted(url.hostname)) {
    throw new OutboundError(`${url.hostname} is not in HTTP_ALLOWED_HOSTS`, false);
  }
  if (url.username || url.password) {
    throw new OutboundError('Credentials in the URL are not allowed', false);
  }
  return url;
}

function sanitizeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase().trim();
    if (BLOCKED_HEADERS.has(name)) continue;
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue;   // header smuggling
    if (/[\r\n]/.test(value)) continue;                        // response splitting
    out[name] = value;
  }
  return out;
}

function once(
  url: URL,
  addresses: string[],
  options: SafeRequestOptions,
): Promise<SafeResponse & { location?: string }> {
  const started = Date.now();
  const timeoutMs = Math.min(options.timeoutMs ?? 15_000, config.maxOutboundTimeoutMs);
  const maxBytes = options.maxBytes ?? config.maxResponseBytes;
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: {
          ...sanitizeHeaders(options.headers),
          host: url.host,
          'user-agent': 'AgentFlow/1.0',
          ...(options.body ? { 'content-length': Buffer.byteLength(options.body) } : {}),
        },
        // Pin the socket to an address we already validated. Without this the
        // hostname would be resolved a second time and could answer differently.
        lookup: (_hostname, _opts, callback) => {
          const address = addresses[0];
          if (!address) {
            (callback as (e: Error | null) => void)(new Error('No validated address'));
            return;
          }
          (callback as (e: Error | null, a: string, f: number) => void)(
            null,
            address,
            net.isIP(address),
          );
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });

        const finish = () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(response.headers)) {
            headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
            durationMs: Date.now() - started,
            finalUrl: url.toString(),
            location: response.headers.location,
          });
        };

        response.on('end', finish);
        response.on('close', () => {
          if (truncated) finish();
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new OutboundError(`Timed out after ${timeoutMs}ms`, true));
    });

    request.on('error', (err) => {
      reject(
        err instanceof OutboundError
          ? err
          : new OutboundError(`Request failed: ${err.message}`, true),
      );
    });

    if (options.body) request.write(options.body);
    request.end();
  });
}

export async function safeRequest(
  rawUrl: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const maxRedirects = options.maxRedirects ?? 2;
  let target = validateUrl(rawUrl);
  let method = options.method ?? 'GET';
  let body = options.body;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const addresses = await resolveAndValidate(target.hostname);
    const response = await once(target, addresses, { ...options, method, body });

    const isRedirect = response.status >= 300 && response.status < 400 && response.location;
    if (!isRedirect) return response;

    if (hop === maxRedirects) {
      throw new OutboundError('Too many redirects', false);
    }
    // Each hop is revalidated from scratch: a public URL redirecting to
    // 169.254.169.254 is the classic metadata-service escape.
    target = validateUrl(new URL(response.location as string, target).toString());
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
    }
  }

  throw new OutboundError('Too many redirects', false);
}
