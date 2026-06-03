import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";
import { logger } from "../util/logger.js";
import { redactUrl } from "../util/redact.js";

/** Maximum retry attempts for CDN upload. */
const UPLOAD_MAX_RETRIES = 3;

/**
 * If no upload progress (no chunk consumed by fetch) for this long, the connection is
 * considered stalled and the attempt is aborted. Resets on every chunk sent.
 */
const CDN_UPLOAD_STALL_MS = 60_000;

/**
 * After the request body is fully uploaded, wait this long for the server's HTTP response.
 * Short because by this point the data is already on the CDN side.
 */
const CDN_RESPONSE_TIMEOUT_MS = 30_000;

/** Chunk size used to stream the upload body so stall detection can fire per-chunk. */
const CDN_CHUNK_SIZE = 64 * 1024; // 64 KB

/**
 * Upload one buffer to the Weixin CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN response.
 * Retries up to UPLOAD_MAX_RETRIES times on server errors; client errors (4xx) abort immediately.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  /** From getUploadUrl.upload_full_url; POST target when set (takes precedence over uploadParam). */
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
}): Promise<{ downloadParam: string }> {
  const { buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, label, aeskey } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const trimmedFull = uploadFullUrl?.trim();
  let cdnUrl: string;
  if (trimmedFull) {
    cdnUrl = trimmedFull;
  } else if (uploadParam) {
    cdnUrl = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  } else {
    throw new Error(`${label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  logger.debug(`${label}: CDN POST url=${redactUrl(cdnUrl)} ciphertextSize=${ciphertext.length}`);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const abortCtrl = new AbortController();
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;

      const armStall = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          logger.error(`${label}: upload stalled >${CDN_UPLOAD_STALL_MS / 1000}s on attempt=${attempt}, aborting`);
          abortCtrl.abort();
        }, CDN_UPLOAD_STALL_MS);
      };
      const clearTimers = () => {
        if (stallTimer !== undefined) { clearTimeout(stallTimer); stallTimer = undefined; }
        if (responseTimer !== undefined) { clearTimeout(responseTimer); responseTimer = undefined; }
      };

      // Stream the body in chunks. Each chunk consumed by fetch resets the stall timer,
      // so a slow-but-steady upload never triggers it. Only a true stall does.
      let offset = 0;
      const bodyStream = new ReadableStream<Uint8Array>({
        start() { armStall(); },
        pull(ctrl) {
          if (offset >= ciphertext.length) {
            // Body fully consumed — switch to response timeout
            if (stallTimer !== undefined) { clearTimeout(stallTimer); stallTimer = undefined; }
            ctrl.close();
            responseTimer = setTimeout(() => {
              logger.error(`${label}: no server response after ${CDN_RESPONSE_TIMEOUT_MS / 1000}s on attempt=${attempt}, aborting`);
              abortCtrl.abort();
            }, CDN_RESPONSE_TIMEOUT_MS);
            return;
          }
          const end = Math.min(offset + CDN_CHUNK_SIZE, ciphertext.length);
          ctrl.enqueue(ciphertext.subarray(offset, end));
          offset = end;
          armStall(); // progress: reset stall timer
        },
        cancel() { clearTimers(); },
      });

      let res: Response;
      try {
        res = await fetch(cdnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bodyStream,
          signal: abortCtrl.signal,
          // Node.js requires duplex:'half' for streaming request bodies
          ...({ duplex: "half" } as Record<string, unknown>),
        } as RequestInit);
      } finally {
        clearTimers();
      }
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get("x-error-message") ?? (await res.text());
        logger.error(
          `${label}: CDN client error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
        logger.error(
          `${label}: CDN server error attempt=${attempt} status=${res.status} errMsg=${errMsg}`,
        );
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        logger.error(
          `${label}: CDN response missing x-encrypted-param header attempt=${attempt}`,
        );
        throw new Error("CDN upload response missing x-encrypted-param header");
      }
      logger.debug(`${label}: CDN upload success attempt=${attempt}`);
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) {
        logger.error(`${label}: attempt ${attempt} failed, retrying... err=${String(err)}`);
      } else {
        logger.error(`${label}: all ${UPLOAD_MAX_RETRIES} attempts failed err=${String(err)}`);
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}
