# nodemailer-cmdsend

Nodemailer transport for [cmdsend.com](https://cmdsend.com), a transactional email API built on Amazon SES.

## Install

```bash
npm install nodemailer-cmdsend nodemailer
```

## Send an email

```js
import nodemailer from "nodemailer";
import { cmdsendTransport } from "nodemailer-cmdsend";

const transporter = nodemailer.createTransport(
  cmdsendTransport({ apiKey: process.env.CMDSEND_API_KEY }),
);

await transporter.sendMail({
  from: "you@yourdomain.com",
  to: "user@example.com",
  subject: "Hello from cmdsend",
  html: "<p>It works.</p>",
});
```

CommonJS: `const { cmdsendTransport } = require("nodemailer-cmdsend");` — everything else is identical.

## Runtime support

**This is a Nodemailer transport, so it runs wherever Nodemailer runs: Node.js.** It does not work on Cloudflare Workers, Vercel Edge Functions, or Deno Deploy — and that's not a limitation of this package specifically, it's Nodemailer itself.

Nodemailer's main entry point unconditionally `require()`s its SMTP transport, which loads Node's `net` and `tls` modules at import time (see [`smtp-connection/index.js`](https://github.com/nodemailer/nodemailer/blob/master/lib/smtp-connection/index.js)). Edge runtimes don't implement `node:net` — there's no raw TCP socket API to give you — so `import nodemailer from "nodemailer"` throws before your code even runs. This is a known, long-standing constraint tracked upstream: [nodemailer/nodemailer#1621](https://github.com/nodemailer/nodemailer/issues/1621) and [#1623](https://github.com/nodemailer/nodemailer/issues/1623). It is not something a transport package layered on top of Nodemailer — this one included — can work around.

So: use `nodemailer-cmdsend` anywhere you're already running Node.js — Express, Fastify, NestJS, Next.js API routes / route handlers / server actions on the **Node.js runtime**, AWS Lambda, containers, or any existing app that already uses Nodemailer.

**On an edge runtime, skip Nodemailer entirely** — you don't need a mail library there, just call cmdsend's HTTP API with `fetch` directly:

```js
// Cloudflare Workers / Vercel Edge / Deno Deploy — no nodemailer, no this package
export default {
  async fetch(request, env) {
    const res = await fetch("https://api.cmdsend.com/v1/emails/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CMDSEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "you@yourdomain.com",
        to: "user@example.com",
        subject: "Hello from the edge",
        html: "<p>It works.</p>",
      }),
    });
    return new Response(await res.text(), { status: res.status });
  },
};
```

| Environment | Works with this package? | If not, use instead |
| --- | --- | --- |
| Node.js 18+ | ✅ | — |
| Next.js — Node.js runtime (API routes, most route handlers / server actions) | ✅ | — |
| Next.js — Edge runtime (`export const runtime = "edge"`) | ❌ | Plain `fetch` to the cmdsend API, as above |
| Cloudflare Workers | ❌ | Plain `fetch` to the cmdsend API, as above |
| Deno Deploy | ❌ | Plain `fetch` to the cmdsend API, as above |
| Bun | ✅ (Bun implements `node:net`/`node:tls`) | — |
| AWS Lambda (Node.js runtime) | ✅ | — |

## Migrating from another transport

Only the transport setup changes — `transporter.sendMail({...})` calls stay exactly the same.

**From `nodemailer-sendgrid`:**

```diff
 import nodemailer from "nodemailer";
-import sgTransport from "nodemailer-sendgrid";
+import { cmdsendTransport } from "nodemailer-cmdsend";

 const transporter = nodemailer.createTransport(
-  sgTransport({ apiKey: process.env.SENDGRID_API_KEY }),
+  cmdsendTransport({ apiKey: process.env.CMDSEND_API_KEY }),
 );
```

**From `nodemailer-mailgun-transport`:**

```diff
 import nodemailer from "nodemailer";
-import mg from "nodemailer-mailgun-transport";
+import { cmdsendTransport } from "nodemailer-cmdsend";

 const transporter = nodemailer.createTransport(
-  mg({ auth: { api_key: process.env.MAILGUN_API_KEY, domain: process.env.MAILGUN_DOMAIN } }),
+  cmdsendTransport({ apiKey: process.env.CMDSEND_API_KEY }),
 );
```

**From plain SMTP:**

```diff
 import nodemailer from "nodemailer";
+import { cmdsendTransport } from "nodemailer-cmdsend";

 const transporter = nodemailer.createTransport(
-  {
-    host: "smtp.example.com",
-    port: 587,
-    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
-  },
+  cmdsendTransport({ apiKey: process.env.CMDSEND_API_KEY }),
 );
```

## Options

```ts
cmdsendTransport({
  apiKey: "cmd_...",
  // baseUrl, maxRetries, timeout, fetch, headers, idempotencyKey are all optional
});
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | `process.env.CMDSEND_API_KEY` | cmdsend API key. Required, either as an option or via the environment variable. |
| `baseUrl` | `string` | `"https://api.cmdsend.com/v1"` | Override the API base URL (e.g. for a proxy). |
| `maxRetries` | `number` | `3` | Retry attempts for `429`/`5xx` responses and transport-level failures (timeouts, DNS, connection resets). |
| `timeout` | `number` | `30000` | Per-request timeout in milliseconds. |
| `fetch` | `typeof fetch` | global `fetch` | Inject a custom `fetch` implementation — used for testing, or to route through a custom agent. |
| `headers` | `Record<string, string>` | `{}` | Extra headers sent with every request. |
| `idempotencyKey` | `boolean \| (mail) => string \| undefined` | `true` | See [Idempotency](#idempotency) below. |

Retries use exponential backoff (1s, 2s, 4s, ... capped at 16s) with up to 50% jitter, and respect a `Retry-After` header when the API sends one. `401`/`403`/`400` and other `4xx` responses are never retried.

### Idempotency

By default, every send request includes an `Idempotency-Key` header derived from the message's `Message-ID` (set explicitly via `mail.messageId`, or generated by Nodemailer). If your app calls `sendMail` again for the same message — e.g. a serverless function retried after a timeout — the key stays the same across attempts, rather than minting a new one per HTTP call.

**This is sent defensively.** cmdsend's public API reference does not currently document idempotency key support, so this cannot be presented as a confirmed guarantee against duplicate sends — verify with cmdsend whether `Idempotency-Key` is honored server-side before relying on it in a way where a duplicate email would be a real problem. Disable it with `idempotencyKey: false`, or supply your own: `idempotencyKey: (mail) => mail.data.messageId`.

## Troubleshooting

**`cmdsend API key is required...`**
No `apiKey` option and no `CMDSEND_API_KEY` environment variable. Set one of the two.

**`401` / "Invalid API key" / "Unauthorized"**
The key is missing, malformed, or was revoked. Check **Settings → API Keys** in the cmdsend dashboard.

**`403` / "Forbidden"**
Usually an unverified sending domain — the `from` address's domain hasn't completed SES/DNS verification in your cmdsend account. Verify it in the dashboard before sending from it.

**`429` / "QuotaExceeded" / rate limited**
Retried automatically (see [Options](#options)). If it still fails after retries, you're sustained over your plan's send rate — the error persists until you're under the limit again or your plan is upgraded.

**`cmdsend request timed out after <N>ms`**
The request didn't complete within `timeout`. Raise the `timeout` option, or check outbound network access from wherever this is running (e.g. a locked-down VPC or container).

**Attachment rejected / request too large**
cmdsend has not published a specific attachment size limit as of this writing. This transport doesn't enforce a client-side cap — if the API rejects a payload as too large, the error message in the thrown `CmdsendError` is the source of truth; treat it as such rather than a fixed number documented here.

**Getting a `CmdsendError` instead of a generic `Error`**
That's intentional — every failure from this transport (network error, timeout, non-2xx response) is normalized into a `CmdsendError` with `.statusCode` and `.code` set when available, instead of a raw `fetch`/`AbortError`.

## A note on API coverage

This transport was built against cmdsend's structured JSON send endpoint (`POST /v1/emails/send`) and the existing `cmdsend` npm SDK, which is the closest thing to a contract available at the time of writing. A few things it supports are **not** confirmed against cmdsend's public API reference and should be verified before you depend on them in production:

- **Attachments and inline CID images** are sent as an `attachments` array (`filename`, base64 `content`, `content_type`, `content_id`). This field isn't part of the documented request schema.
- **Custom headers** (`mail.headers`) are sent as a `headers` object on the request body, also undocumented.
- **`Idempotency-Key`** — see [Idempotency](#idempotency) above.
- There is no known raw-MIME send endpoint, so this transport always sends structured JSON rather than a raw `message/rfc822` body.
- `verify()` has no dedicated auth-check endpoint to call, so it does a `GET` on a placeholder email id and treats `401`/`403` as failure, anything else as success.

A send that only uses documented fields (`from`/`to`/`cc`/`bcc`/`subject`/`html`/`text`/`reply_to`) isn't affected by any of this. But if you rely on attachments, custom headers, or idempotency: we don't know whether cmdsend's request validation ignores unrecognized fields or rejects the whole request, so test against your own account before depending on them in production.

## Learn more

cmdsend API docs: https://cmdsend.com/docs
