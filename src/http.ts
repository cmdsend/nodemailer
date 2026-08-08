import { CmdsendError } from "./errors.js";

// 429 and 5xx are treated as transient and safe to retry. 4xx auth/validation
// errors (400, 401, 403, 404, 422, ...) are never retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export type FetchLike = typeof fetch;

export interface RequestJsonOptions {
  fetchImpl: FetchLike;
  maxRetries: number;
  timeoutMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff (base 1s, capped at 16s) with up to 50% jitter. */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, 16_000);
  return base + Math.random() * base * 0.5;
}

function retryAfterDelayMs(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

async function parseErrorBody(res: Response): Promise<{ message?: string; code?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return {
      message: typeof body.message === "string" ? body.message : undefined,
      code: typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * POSTs/GETs JSON against the cmdsend API with retry on 429/5xx (respecting
 * Retry-After) and on transport-level failures (timeout, DNS, connection
 * reset). 4xx auth/validation errors fail immediately without retrying.
 */
export async function requestJson(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  options: RequestJsonOptions,
): Promise<unknown> {
  const { fetchImpl, maxRetries, timeoutMs } = options;
  let lastError: CmdsendError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;

    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const error = new CmdsendError(
        isAbort ? `cmdsend request timed out after ${timeoutMs}ms` : `cmdsend request failed: ${(err as Error).message}`,
        { cause: err },
      );
      if (attempt < maxRetries) {
        lastError = error;
        await sleep(backoffDelayMs(attempt));
        continue;
      }
      throw error;
    }

    clearTimeout(timer);

    if (res.ok) {
      return await res.json().catch(() => ({}));
    }

    const { message, code } = await parseErrorBody(res);
    const error = new CmdsendError(message ?? `cmdsend request failed with status ${res.status}`, {
      statusCode: res.status,
      code,
    });

    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      lastError = error;
      const delay = retryAfterDelayMs(res.headers.get("retry-after")) ?? backoffDelayMs(attempt);
      await sleep(delay);
      continue;
    }

    throw error;
  }

  throw lastError ?? new CmdsendError("cmdsend request failed");
}
