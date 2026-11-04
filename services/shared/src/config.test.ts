import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { LAB_ID_RE, labNamespace, newLabId } from "./ids.js";

const base = { DATABASE_URL: "postgres://x" };

describe("loadConfig", () => {
  it("applies the spec defaults", () => {
    const c = loadConfig(base);
    expect(c.lab.ttlSeconds).toBe(45 * 60);
    expect(c.lab.poolSize).toBe(3);
    expect(c.lab.maxConcurrent).toBe(10);
    expect(c.network.internetEgress).toBe(true);
    expect(c.devFakeAuth).toBe(false);
  });

  it.each([
    ["30s", 30],
    ["2m", 120],
    ["1h", 3600],
  ])("parses LAB_TTL=%s as %i seconds", (ttl, seconds) => {
    expect(loadConfig({ ...base, LAB_TTL: ttl }).lab.ttlSeconds).toBe(seconds);
  });

  it("rejects a TTL without a unit, naming the variable", () => {
    expect(() => loadConfig({ ...base, LAB_TTL: "45" })).toThrow(/LAB_TTL/);
  });

  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it("refuses fake dev auth in production", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", DEV_FAKE_AUTH: "true" }),
    ).toThrow(/DEV_FAKE_AUTH/);
  });

  it("parses booleans and strips a trailing slash from the base URL", () => {
    const c = loadConfig({
      ...base,
      LAB_INTERNET_EGRESS: "false",
      PUBLIC_BASE_URL: "https://labs.gurnoor.online/",
    });
    expect(c.network.internetEgress).toBe(false);
    expect(c.publicBaseUrl).toBe("https://labs.gurnoor.online");
  });

  it("rejects a malformed CIDR", () => {
    expect(() => loadConfig({ ...base, POD_CIDR: "10.42.0.0" })).toThrow(/POD_CIDR/);
  });
});

describe("lab ids", () => {
  it("are 16 lowercase url- and namespace-safe chars", () => {
    const id = newLabId();
    expect(id).toMatch(/^[a-z2-7]{16}$/);
    expect(LAB_ID_RE.test(id)).toBe(true);
    expect(labNamespace(id)).toBe(`lab-${id}`);
  });

  it("do not repeat", () => {
    const ids = new Set(Array.from({ length: 1000 }, newLabId));
    expect(ids.size).toBe(1000);
  });
});
