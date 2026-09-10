import type MailMessage from "nodemailer/lib/mailer/mail-message.js";
import type { Transport } from "nodemailer";

import { CmdsendError } from "./errors.js";
import { requestJson, type FetchLike } from "./http.js";
import { buildSendPayload, type NormalizedMail } from "./payload.js";

// Keep in sync with package.json "version".
const VERSION = "0.1.1";

const DEFAULT_BASE_URL = "https://api.cmdsend.com/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

export interface CmdsendSentMessageInfo {
  /** cmdsend's email id when available, otherwise the generated Message-ID. */
  messageId: string;
  envelope: { from: string | false; to: string[] };
  /** Short human-readable summary of the API response, for logging. */
  response: string;
}

export interface CmdsendTransportOptions {
  /** cmdsend API key. Falls back to the CMDSEND_API_KEY environment variable. */
  apiKey?: string;
  /** Override the API base URL (default: "https://api.cmdsend.com/v1"). */
  baseUrl?: string;
  /** Max retry attempts for 429/5xx responses and transport-level failures. Default: 3. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Default: 30000. */
  timeout?: number;
  /** Inject a custom fetch implementation (e.g. for testing). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * Controls the `Idempotency-Key` header sent with each send request.
   *
   * `true` (default): derive a key from the message's Message-ID header, so
   * retried requests (e.g. a serverless function retried after a timeout)
   * don't risk a duplicate send. `false`: don't send the header. Or pass a
   * function to compute your own key per message.
   *
   * NOTE: cmdsend's public API reference does not document idempotency key
   * support. This header is sent defensively; verify with cmdsend whether
   * it's honored server-side before relying on it to prevent duplicate
   * sends in production.
   */
  idempotencyKey?: boolean | ((mail: MailMessage) => string | undefined);
}

interface CmdsendSendResponse {
  id?: string;
  status?: string;
}

function resolveApiKey(options: CmdsendTransportOptions): string {
  const apiKey = options.apiKey ?? process.env.CMDSEND_API_KEY;
  if (!apiKey) {
    throw new CmdsendError(
      "cmdsend API key is required. Pass { apiKey } to the transport, or set the CMDSEND_API_KEY environment variable.",
    );
  }
  return apiKey;
}

function resolveFetch(options: CmdsendTransportOptions): FetchLike {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new CmdsendError(
      "No fetch implementation available. Use Node.js 18+ (which has a global fetch), or pass { fetch } explicitly.",
    );
  }
  return fetchImpl;
}

function normalizeMail(mail: MailMessage): Promise<NormalizedMail> {
  return new Promise((resolve, reject) => {
    mail.normalize((err, data) => {
      if (err) {
        reject(err instanceof Error ? err : new CmdsendError(String(err)));
        return;
      }
      resolve(data as unknown as NormalizedMail);
    });
  });
}

function resolveIdempotencyKey(
  option: boolean | ((mail: MailMessage) => string | undefined) | undefined,
  mail: MailMessage,
  fallbackMessageId: string,
): string | undefined {
  if (option === false) return undefined;
  if (typeof option === "function") return option(mail);
  // Default: derive from the Message-ID header (stripped of angle brackets)
  // so retrying the same message doesn't mint a new key.
  return fallbackMessageId.replace(/^<|>$/g, "") || undefined;
}

/**
 * Nodemailer transport for cmdsend.com. Sends via cmdsend's structured JSON
 * endpoint (POST /emails/send) — see README "API assumptions" for exactly
 * which fields are confirmed vs. best-effort.
 */
export class CmdsendTransport implements Transport<CmdsendSentMessageInfo> {
  public readonly name = "Cmdsend";
  public readonly version = VERSION;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #timeout: number;
  readonly #fetch: FetchLike;
  readonly #headers: Record<string, string>;
  readonly #idempotencyKey: boolean | ((mail: MailMessage) => string | undefined) | undefined;

  constructor(options: CmdsendTransportOptions = {}) {
    this.#apiKey = resolveApiKey(options);
    this.#fetch = resolveFetch(options);
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.#headers = options.headers ?? {};
    this.#idempotencyKey = options.idempotencyKey;
  }

  send(mail: MailMessage, callback: (err: Error | null, info: CmdsendSentMessageInfo) => void): void {
    this.#send(mail).then(
      (info) => callback(null, info),
      (err: unknown) =>
        callback(err instanceof Error ? err : new CmdsendError(String(err)), undefined as unknown as CmdsendSentMessageInfo),
    );
  }

  async #send(mail: MailMessage): Promise<CmdsendSentMessageInfo> {
    const envelope = mail.message.getEnvelope();
    const fallbackMessageId = mail.message.messageId();
    const data = await normalizeMail(mail);
    const payload = buildSendPayload(data);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "Content-Type": "application/json",
      ...this.#headers,
    };

    const idempotencyKey = resolveIdempotencyKey(this.#idempotencyKey, mail, fallbackMessageId);
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const body = (await requestJson(
      `${this.#baseUrl}/emails/send`,
      { method: "POST", headers, body: JSON.stringify(payload) },
      { fetchImpl: this.#fetch, maxRetries: this.#maxRetries, timeoutMs: this.#timeout },
    )) as CmdsendSendResponse;

    const messageId = body?.id ?? fallbackMessageId;
    return {
      messageId,
      envelope,
      response: `${body?.status ?? "accepted"} id=${messageId}`,
    };
  }

  /**
   * Cheap auth check. cmdsend has no dedicated "whoami"/health endpoint, so
   * this issues a GET against the one other confirmed route (fetch-email-
   * by-id) with a placeholder id — a request that can never send mail. A
   * 401/403 response means the key is rejected; any other status (404
   * "not found", 200, ...) means the key was accepted by auth middleware.
   * This ordering assumption (auth checked before the id lookup) is not
   * confirmed against cmdsend's source — see the README.
   */
  verify(): Promise<true>;
  verify(callback: (err: Error | null, success: true) => void): void;
  verify(callback?: (err: Error | null, success: true) => void): void | Promise<true> {
    const promise = this.#verify();
    if (!callback) return promise;
    promise.then(
      (ok) => callback(null, ok),
      (err: unknown) => callback(err instanceof Error ? err : new CmdsendError(String(err)), true),
    );
    return undefined;
  }

  async #verify(): Promise<true> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}/emails/00000000-0000-0000-0000-000000000000`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#apiKey}`, ...this.#headers },
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      throw new CmdsendError(
        isAbort
          ? `cmdsend verification timed out after ${this.#timeout}ms`
          : `cmdsend verification failed: ${(err as Error).message}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new CmdsendError(body.message ?? "cmdsend authentication failed", {
        statusCode: res.status,
        code: body.error,
      });
    }

    return true;
  }
}
