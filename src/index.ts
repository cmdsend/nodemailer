import { CmdsendTransport, type CmdsendTransportOptions } from "./transport.js";

export { CmdsendTransport } from "./transport.js";
export type { CmdsendTransportOptions, CmdsendSentMessageInfo } from "./transport.js";
export { CmdsendError, type CmdsendErrorOptions } from "./errors.js";
export type { CmdsendSendPayload, CmdsendAttachmentPayload } from "./payload.js";

/**
 * Creates a cmdsend transport for Nodemailer:
 *
 * ```ts
 * import nodemailer from "nodemailer";
 * import { cmdsendTransport } from "nodemailer-cmdsend";
 *
 * const transporter = nodemailer.createTransport(
 *   cmdsendTransport({ apiKey: process.env.CMDSEND_API_KEY }),
 * );
 * ```
 */
export function cmdsendTransport(options?: CmdsendTransportOptions): CmdsendTransport {
  return new CmdsendTransport(options);
}
