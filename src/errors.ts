export interface CmdsendErrorOptions {
  /** HTTP status code returned by the cmdsend API, if this error came from a response. */
  statusCode?: number;
  /** Machine-readable error code from the cmdsend API's error body (e.g. "Unauthorized"). */
  code?: string;
  cause?: unknown;
}

/**
 * Error type thrown by this transport. Network failures, timeouts, and
 * non-2xx API responses are all normalized into this shape instead of
 * leaking raw fetch/AbortError objects to callers.
 */
export class CmdsendError extends Error {
  readonly statusCode?: number;
  readonly code?: string;

  constructor(message: string, options: CmdsendErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CmdsendError";
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}
