import { describe, expect, it } from "vitest";
import { normalizeRateIp } from "../src/lib/rate-ip";

describe("normalizeRateIp", () => {
  it("passes IPv4 through unchanged", () => {
    expect(normalizeRateIp("203.0.113.9")).toBe("203.0.113.9");
  });
  it("truncates a full IPv6 to its /64", () => {
    expect(normalizeRateIp("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2");
  });
  it("expands :: before truncating", () => {
    expect(normalizeRateIp("2001:db8::1")).toBe("2001:db8:0:0");
    expect(normalizeRateIp("::1")).toBe("0:0:0:0");
  });
  it("lowercases and strips brackets / zone ids", () => {
    expect(normalizeRateIp("[2001:DB8:AA:BB::1]")).toBe("2001:db8:aa:bb");
    expect(normalizeRateIp("fe80::1%eth0")).toBe("fe80:0:0:0");
  });
  it("passes opaque values through", () => {
    expect(normalizeRateIp("unknown")).toBe("unknown");
    expect(normalizeRateIp(":::")).toBe(":::");
  });
});
