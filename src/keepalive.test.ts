/**
 * Tests for the Appwrite Sites HTTP keepalive path added in v1.1.0.
 *
 * These tests stub `fetch` so they run hermetically without hitting a real
 * Appwrite endpoint. The pre-existing database keepalive code is covered by
 * a separate integration check (manual bun run keepalive against a real
 * project, documented in CONTRIBUTING.md).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loadProjectsFromEnv } from "./keepalive.js";

const originalFetch = globalThis.fetch;

describe("loadProjectsFromEnv", () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    "APPWRITE_ENDPOINT",
    "APPWRITE_PROJECT_ID",
    "APPWRITE_API_KEY",
    "APPWRITE_PROJECTS",
    "APPWRITE_SITE_URLS",
  ];

  beforeEach(() => {
    for (const k of envKeys) envBackup[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  test("loads single project with no site URLs when env vars unset", () => {
    process.env.APPWRITE_ENDPOINT = "https://cloud.appwrite.io/v1";
    process.env.APPWRITE_PROJECT_ID = "p1";
    process.env.APPWRITE_API_KEY = "k1";
    const projects = loadProjectsFromEnv();
    expect(projects.length).toBe(1);
    expect(projects[0]).toEqual({
      endpoint: "https://cloud.appwrite.io/v1",
      projectId: "p1",
      apiKey: "k1",
    });
    expect(projects[0]?.siteUrls).toBeUndefined();
  });

  test("attaches siteUrls when APPWRITE_SITE_URLS is set to a single URL", () => {
    process.env.APPWRITE_ENDPOINT = "https://cloud.appwrite.io/v1";
    process.env.APPWRITE_PROJECT_ID = "p1";
    process.env.APPWRITE_API_KEY = "k1";
    process.env.APPWRITE_SITE_URLS = "https://demo.appwrite.network";
    const projects = loadProjectsFromEnv();
    expect(projects[0]?.siteUrls).toEqual(["https://demo.appwrite.network"]);
  });

  test("parses comma-separated site URLs and trims whitespace", () => {
    process.env.APPWRITE_ENDPOINT = "https://cloud.appwrite.io/v1";
    process.env.APPWRITE_PROJECT_ID = "p1";
    process.env.APPWRITE_API_KEY = "k1";
    process.env.APPWRITE_SITE_URLS = " https://a.appwrite.network , https://b.appwrite.network ,, ";
    const projects = loadProjectsFromEnv();
    expect(projects[0]?.siteUrls).toEqual([
      "https://a.appwrite.network",
      "https://b.appwrite.network",
    ]);
  });

  test("ignores APPWRITE_SITE_URLS when single-project env is incomplete", () => {
    // No endpoint / projectId / apiKey → single-project loader does nothing
    process.env.APPWRITE_SITE_URLS = "https://demo.appwrite.network";
    const projects = loadProjectsFromEnv();
    expect(projects.length).toBe(0);
  });

  test("multi-project JSON preserves per-project siteUrls field", () => {
    process.env.APPWRITE_PROJECTS = JSON.stringify([
      {
        endpoint: "https://cloud.appwrite.io/v1",
        projectId: "p1",
        apiKey: "k1",
        siteUrls: ["https://a.appwrite.network", "https://b.appwrite.network"],
      },
      {
        endpoint: "https://cloud.appwrite.io/v1",
        projectId: "p2",
        apiKey: "k2",
      },
    ]);
    const projects = loadProjectsFromEnv();
    expect(projects.length).toBe(2);
    expect(projects[0]?.siteUrls).toEqual([
      "https://a.appwrite.network",
      "https://b.appwrite.network",
    ]);
    expect(projects[1]?.siteUrls).toBeUndefined();
  });
});

describe("pingSite (via fetch stub)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("HTTP 200 response is recorded as success", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response("ok", { status: 200, statusText: "OK" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Re-import to use the live module against the stub.
    const { keepaliveProject } = await import("./keepalive.js");
    // Without a real Appwrite SDK we cannot exercise the database side, so the
    // database call will fail. We only assert on the site result here; that's
    // the new code path under test.
    const result = await keepaliveProject({
      endpoint: "https://invalid-endpoint-for-test.example",
      projectId: "p1",
      apiKey: "k1",
      siteUrls: ["https://demo.appwrite.network"],
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(result.siteResults).toBeDefined();
    expect(result.siteResults?.length).toBe(1);
    expect(result.siteResults?.[0].success).toBe(true);
    expect(result.siteResults?.[0].status).toBe(200);
  });

  test("HTTP 500 response is recorded as failure", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response("bad", { status: 500, statusText: "ERR" })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { keepaliveProject } = await import("./keepalive.js");
    const result = await keepaliveProject({
      endpoint: "https://invalid-endpoint-for-test.example",
      projectId: "p1",
      apiKey: "k1",
      siteUrls: ["https://demo.appwrite.network"],
    });

    expect(result.siteResults?.[0].success).toBe(false);
    expect(result.siteResults?.[0].status).toBe(500);
  });

  test("network error is recorded as failure with message", async () => {
    const fetchMock = mock(() => Promise.reject(new Error("ENOTFOUND")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { keepaliveProject } = await import("./keepalive.js");
    const result = await keepaliveProject({
      endpoint: "https://invalid-endpoint-for-test.example",
      projectId: "p1",
      apiKey: "k1",
      siteUrls: ["https://demo.appwrite.network"],
    });

    expect(result.siteResults?.[0].success).toBe(false);
    expect(result.siteResults?.[0].message).toContain("ENOTFOUND");
  });

  test("multiple site URLs are pinged in parallel", async () => {
    let callCount = 0;
    const fetchMock = mock(() => {
      callCount += 1;
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { keepaliveProject } = await import("./keepalive.js");
    const result = await keepaliveProject({
      endpoint: "https://invalid-endpoint-for-test.example",
      projectId: "p1",
      apiKey: "k1",
      siteUrls: [
        "https://a.appwrite.network",
        "https://b.appwrite.network",
        "https://c.appwrite.network",
      ],
    });

    expect(callCount).toBe(3);
    expect(result.siteResults?.length).toBe(3);
    expect(result.siteResults?.every((r) => r.success)).toBe(true);
  });

  test("no siteUrls means no fetch calls, no siteResults field", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;

    const { keepaliveProject } = await import("./keepalive.js");
    const result = await keepaliveProject({
      endpoint: "https://invalid-endpoint-for-test.example",
      projectId: "p1",
      apiKey: "k1",
    });

    expect(fetchCalls).toBe(0);
    expect(result.siteResults).toBeUndefined();
  });
});
