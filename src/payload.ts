import { CmdsendError } from "./errors.js";

interface NormalizedAddress {
  name?: string;
  address: string;
}

interface NormalizedAttachment {
  content?: string | Buffer;
  encoding?: string;
  filename?: string | false;
  contentType?: string;
  cid?: string;
}

/** Shape of `mail.data` after `MailMessage#normalize()` has resolved it. */
export interface NormalizedMail {
  from?: NormalizedAddress | null;
  to?: NormalizedAddress[] | null;
  cc?: NormalizedAddress[] | null;
  bcc?: NormalizedAddress[] | null;
  replyTo?: NormalizedAddress[] | null;
  subject?: string;
  html?: string;
  text?: string;
  attachments?: NormalizedAttachment[];
  normalizedHeaders?: Record<string, string>;
}

export interface CmdsendAttachmentPayload {
  filename: string;
  content: string;
  content_type?: string;
  content_id?: string;
}

/**
 * Body sent to POST /emails/send. Only `from`/`to`/`subject`/`html`/`text`/
 * `cc`/`bcc`/`reply_to` are confirmed fields (mirrored from the `cmdsend`
 * npm SDK). `attachments` and `headers` are NOT part of that confirmed
 * contract — see the "API assumptions" section of the README.
 */
export interface CmdsendSendPayload {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  attachments?: CmdsendAttachmentPayload[];
  headers?: Record<string, string>;
}

function formatAddress(addr: NormalizedAddress): string {
  if (!addr.name) return addr.address;
  const needsQuoting = /[",;:<>()@]/.test(addr.name) || /^\s|\s$/.test(addr.name);
  const name = needsQuoting ? `"${addr.name.replace(/"/g, '\\"')}"` : addr.name;
  return `${name} <${addr.address}>`;
}

function formatAddressList(list: NormalizedAddress[] | null | undefined): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map(formatAddress);
}

function encodeAttachmentContent(attachment: NormalizedAttachment): string {
  const content = attachment.content;
  if (Buffer.isBuffer(content)) return content.toString("base64");
  if (typeof content === "string") {
    // normalize() already base64-encodes Buffer-sourced content (and sets
    // encoding: "base64"); a plain string here means the user passed a raw
    // utf8 string, which we still need to encode for JSON transport.
    if (attachment.encoding === "base64") return content;
    return Buffer.from(content, "utf8").toString("base64");
  }
  return "";
}

export function buildSendPayload(data: NormalizedMail): CmdsendSendPayload {
  if (!data.from) {
    throw new CmdsendError('"from" address is required to send with cmdsend.');
  }
  const to = formatAddressList(data.to);
  if (!to) {
    throw new CmdsendError('At least one "to" address is required to send with cmdsend.');
  }

  const payload: CmdsendSendPayload = {
    from: formatAddress(data.from),
    to,
    subject: data.subject ?? "",
  };

  if (data.html) payload.html = data.html;
  if (data.text) payload.text = data.text;
  if (!payload.html && !payload.text) {
    throw new CmdsendError('Either "html" or "text" body is required to send with cmdsend.');
  }

  const cc = formatAddressList(data.cc);
  if (cc) payload.cc = cc;

  const bcc = formatAddressList(data.bcc);
  if (bcc) payload.bcc = bcc;

  const replyTo = formatAddressList(data.replyTo);
  if (replyTo) payload.reply_to = replyTo.join(", ");

  if (data.attachments && data.attachments.length > 0) {
    payload.attachments = data.attachments.map((attachment) => {
      const mapped: CmdsendAttachmentPayload = {
        filename: typeof attachment.filename === "string" ? attachment.filename : "attachment",
        content: encodeAttachmentContent(attachment),
      };
      if (attachment.contentType) mapped.content_type = attachment.contentType;
      if (attachment.cid) mapped.content_id = attachment.cid;
      return mapped;
    });
  }

  if (data.normalizedHeaders && Object.keys(data.normalizedHeaders).length > 0) {
    payload.headers = data.normalizedHeaders;
  }

  return payload;
}
