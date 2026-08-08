import { describe, it, expect, vi, afterEach } from "vitest";
import { cmdsendTransport, CmdsendError } from "../src/index.js";
import type { FetchLike } from "../src/http.js";
import { jsonResponse, makeTransport } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
});

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return JSON.parse(init.body as string);
}

describe("send", () => {
  it("sends a plain text email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_123", status: "queued" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    const info = await transporter.sendMail({
      from: "Sender <sender@example.com>",
      to: "recipient@example.com",
      subject: "Hello",
      text: "Hi there",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cmdsend.com/v1/emails/send");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cmd_test_key");

    const body = lastRequestBody(fetchMock);
    expect(body.from).toBe("Sender <sender@example.com>");
    expect(body.to).toEqual(["recipient@example.com"]);
    expect(body.subject).toBe("Hello");
    expect(body.text).toBe("Hi there");
    expect(body.html).toBeUndefined();

    expect(info.messageId).toBe("email_123");
    expect(info.envelope.from).toBe("sender@example.com");
    expect(info.envelope.to).toEqual(["recipient@example.com"]);
  });

  it("sends an HTML + text multipart email", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_multi", status: "queued" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await transporter.sendMail({
      from: "sender@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Multipart",
      html: "<p>Hello</p>",
      text: "Hello",
    });

    const body = lastRequestBody(fetchMock);
    expect(body.html).toBe("<p>Hello</p>");
    expect(body.text).toBe("Hello");
    expect(body.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("base64-encodes attachment content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_456", status: "queued" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Attachment test",
      text: "See attached",
      attachments: [{ filename: "hello.txt", content: "Hello, world!" }],
    });

    const body = lastRequestBody(fetchMock) as { attachments: Array<{ filename: string; content: string }> };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.filename).toBe("hello.txt");
    expect(Buffer.from(body.attachments[0]?.content ?? "", "base64").toString("utf8")).toBe("Hello, world!");
  });

  it("sends inline CID image attachments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_789", status: "queued" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Inline image",
      html: '<img src="cid:logo@example.com" />',
      attachments: [{ filename: "logo.png", content: png, cid: "logo@example.com", contentType: "image/png" }],
    });

    const body = lastRequestBody(fetchMock) as {
      attachments: Array<{ content_id: string; content_type: string; content: string }>;
    };
    expect(body.attachments[0]?.content_id).toBe("logo@example.com");
    expect(body.attachments[0]?.content_type).toBe("image/png");
    expect(Buffer.from(body.attachments[0]?.content ?? "", "base64").equals(png)).toBe(true);
  });

  it("forwards custom headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_abc", status: "queued" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Headers test",
      text: "Body",
      headers: { "X-Custom-Header": "custom-value" },
    });

    const body = lastRequestBody(fetchMock) as { headers: Record<string, string> };
    expect(body.headers["X-Custom-Header"]).toBe("custom-value");
  });

  it("derives the Idempotency-Key from the Message-ID by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_idem", status: "queued" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Idempotency",
      text: "Body",
      messageId: "<fixed-id@example.com>",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("fixed-id@example.com");
  });

  it("fails immediately on 401 without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized", message: "Invalid API key" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await expect(
      transporter.sendMail({ from: "sender@example.com", to: "recipient@example.com", subject: "x", text: "y" }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: "Unauthorized",
      message: "Invalid API key",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429, respecting Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: "QuotaExceeded", message: "Rate limited" }, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "email_retry", status: "queued" }));

    const transporter = makeTransport(fetchMock as unknown as FetchLike, { maxRetries: 2 });

    const sendPromise = transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Retry",
      text: "Body",
    });

    await vi.runAllTimersAsync();
    const info = await sendPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(info.messageId).toBe("email_retry");
  });

  it("exhausts retries on persistent 5xx errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, { error: "ServiceUnavailable", message: "try later" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike, { maxRetries: 2 });

    const sendPromise = transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "x",
      text: "y",
    });
    const assertion = expect(sendPromise).rejects.toMatchObject({ statusCode: 503 });

    await vi.runAllTimersAsync();
    await assertion;

    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("wraps a request timeout in a CmdsendError", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const transporter = makeTransport(fetchMock as unknown as FetchLike, { timeout: 500, maxRetries: 0 });

    const sendPromise = transporter.sendMail({
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "x",
      text: "y",
    });
    const assertion = expect(sendPromise).rejects.toThrow(/timed out/);

    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("verify", () => {
  it("resolves true when the API key is accepted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await expect(transporter.verify()).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.cmdsend.com/v1/emails/00000000-0000-0000-0000-000000000000");
  });

  it("rejects with a CmdsendError when the API key is rejected", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "Unauthorized", message: "Invalid API key" }));
    const transporter = makeTransport(fetchMock as unknown as FetchLike);

    await expect(transporter.verify()).rejects.toBeInstanceOf(CmdsendError);
    await expect(transporter.verify()).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("construction", () => {
  it("throws when no API key is available", () => {
    const originalEnv = process.env.CMDSEND_API_KEY;
    delete process.env.CMDSEND_API_KEY;
    try {
      expect(() => cmdsendTransport({ fetch: vi.fn() as unknown as FetchLike })).toThrow(/API key is required/);
    } finally {
      if (originalEnv !== undefined) process.env.CMDSEND_API_KEY = originalEnv;
    }
  });

  it("falls back to CMDSEND_API_KEY from the environment", async () => {
    const originalEnv = process.env.CMDSEND_API_KEY;
    process.env.CMDSEND_API_KEY = "cmd_from_env";
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: "email_env", status: "queued" }));
      const transporter = makeTransport(fetchMock as unknown as FetchLike, { apiKey: undefined });

      await transporter.sendMail({ from: "sender@example.com", to: "recipient@example.com", subject: "x", text: "y" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cmd_from_env");
    } finally {
      if (originalEnv === undefined) delete process.env.CMDSEND_API_KEY;
      else process.env.CMDSEND_API_KEY = originalEnv;
    }
  });
});

describe.skipIf(!process.env.CMDSEND_API_KEY)("integration (live API)", () => {
  it("sends a real email end-to-end", async () => {
    const transporter = makeTransport(globalThis.fetch, {
      apiKey: process.env.CMDSEND_API_KEY,
      fetch: undefined,
    });

    const info = await transporter.sendMail({
      from: process.env.CMDSEND_TEST_FROM ?? "test@example.com",
      to: process.env.CMDSEND_TEST_TO ?? "test@example.com",
      subject: "nodemailer-cmdsend integration test",
      text: "This is a live integration test run from the nodemailer-cmdsend test suite.",
    });

    expect(info.messageId).toBeTruthy();
  });
});
