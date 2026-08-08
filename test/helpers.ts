import nodemailer from "nodemailer";
import { cmdsendTransport, type CmdsendTransportOptions } from "../src/index.js";
import type { FetchLike } from "../src/http.js";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function makeTransport(fetchImpl: FetchLike, options: Partial<CmdsendTransportOptions> = {}) {
  return nodemailer.createTransport(
    cmdsendTransport({
      apiKey: "cmd_test_key",
      fetch: fetchImpl,
      maxRetries: 2,
      timeout: 1000,
      ...options,
    }),
  );
}
