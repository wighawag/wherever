/**
 * Compression for the web app's static files (the JS/CSS/HTML shell).
 *
 * The app shell is a few MB of text (the main JS chunk alone is ~330 KB) and is
 * downloaded again after every deploy, which over a slow phone link was a long,
 * uncompressed wait. Text assets are compressed once per (content, encoding)
 * and kept in memory: the build is small and fixed, so the cache is bounded by
 * the build itself (plus a hard cap as a backstop). Already-compressed formats
 * (images, fonts, audio, archives) are served as is.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export type ContentEncoding = 'br' | 'gzip';

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json|wasm|xml)|image\/svg\+xml)/;
/** Below this, compression saves too little to be worth a header. */
const MIN_BYTES = 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export function isCompressible(contentType: string, size: number): boolean {
  return size >= MIN_BYTES && COMPRESSIBLE.test(contentType);
}

/**
 * Pick the encoding from an `Accept-Encoding` header: brotli when offered, else
 * gzip, else none. A `q=0` entry is a refusal.
 */
export function negotiateEncoding(accept: string | string[] | undefined): ContentEncoding | null {
  const header = Array.isArray(accept) ? accept.join(',') : accept;
  if (!header) return null;
  const offered = new Map<string, number>();
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    offered.set(name, q ? Number(q.slice(2)) : 1);
  }
  const ok = (enc: string) => {
    const q = offered.get(enc) ?? offered.get('*');
    return q !== undefined && q > 0;
  };
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

const cache = new Map<string, Buffer>();
const inFlight = new Map<string, Promise<Buffer>>();
let cacheBytes = 0;

/**
 * Compress `data`, memoised by a hash of the bytes themselves, so a file
 * replaced by a deploy can never be served from a stale entry (keying on the
 * path + mtime raced the read: the old bytes could be stored under the new
 * stamp). Concurrent first requests for the same bytes share one compression.
 */
export function compressCached(data: Buffer, encoding: ContentEncoding): Promise<Buffer> {
  const k = `${encoding}:${crypto.createHash('sha1').update(data).digest('hex')}`;
  const hit = cache.get(k);
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(k);
  if (pending) return pending;
  const job = (
    encoding === 'br'
      ? brotli(data, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        })
      : gzip(data, { level: 9 })
  )
    .then((out) => {
      if (cacheBytes + out.length > MAX_CACHE_BYTES) {
        cache.clear();
        cacheBytes = 0;
      }
      cache.set(k, out);
      cacheBytes += out.length;
      return out;
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, job);
  return job;
}
