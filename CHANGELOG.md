# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-08

### Added

- Initial release: Nodemailer transport for cmdsend.com.
- Structured JSON send via `POST /v1/emails/send` (from, to, cc, bcc, subject, html, text, reply_to).
- Attachments (including inline CID images) and custom headers, mapped from Nodemailer's normalized mail data.
- Retry with exponential backoff + jitter on 429/5xx responses, respecting `Retry-After`; no retry on 4xx auth/validation errors.
- `Idempotency-Key` header derived from the message's `Message-ID` by default, to reduce double-send risk on retried calls.
- `verify()` cheap auth check.
- Zero runtime dependencies; `nodemailer` as a peer dependency; dual ESM/CJS build with bundled `.d.ts`.
