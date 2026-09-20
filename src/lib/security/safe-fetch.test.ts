import { describe, expect, it, vi } from "vitest";
import { DomainFetchCache, isBlockedHostname, isPrivateOrLinkLocalIp, safeFetchPage, SafeFetchError } from "./safe-fetch";

describe("isBlockedHostname", () => {
  it("blocks localhost and internal suffixes", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("printer.local")).toBe(true);
    expect(isBlockedHostname("service.internal")).toBe(true);
  });

  it("allows a normal public hostname", () => {
    expect(isBlockedHostname("farmaciadelgado.example.es")).toBe(false);
  });
});

describe("isPrivateOrLinkLocalIp", () => {
  it("blocks loopback, private ranges and link-local/metadata IPs", () => {
    expect(isPrivateOrLinkLocalIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrLinkLocalIp("10.0.0.5")).toBe(true);
    expect(isPrivateOrLinkLocalIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrLinkLocalIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrLinkLocalIp("169.254.169.254")).toBe(true);
    expect(isPrivateOrLinkLocalIp("::1")).toBe(true);
    expect(isPrivateOrLinkLocalIp("fe80::1")).toBe(true);
  });

  it("allows a public IP", () => {
    expect(isPrivateOrLinkLocalIp("93.184.216.34")).toBe(false);
  });
});

function jsonResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...init.headers },
  });
}

describe("safeFetchPage", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(safeFetchPage("ftp://example.es/file")).rejects.toThrow(SafeFetchError);
  });

  it("rejects private/loopback hostnames before ever calling fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(safeFetchPage("http://127.0.0.1/admin", { fetchImpl })).rejects.toThrow(SafeFetchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches a normal HTML page successfully", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("<html>hola</html>"));
    const result = await safeFetchPage("https://farmaciadelgado.example.es/contacto", { fetchImpl });
    expect(result.status).toBe(200);
    expect(result.body).toContain("hola");
  });

  it("follows redirects up to the limit, re-validating each hop", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://farmaciadelgado.example.es/es/contacto" } }))
      .mockResolvedValueOnce(jsonResponse("<html>final</html>"));
    const result = await safeFetchPage("https://farmaciadelgado.example.es/contacto", { fetchImpl });
    expect(result.body).toContain("final");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect that hops to a private IP", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    await expect(safeFetchPage("https://farmaciadelgado.example.es/contacto", { fetchImpl })).rejects.toThrow(SafeFetchError);
  });

  it("rejects too many redirects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://farmaciadelgado.example.es/loop" } }));
    await expect(safeFetchPage("https://farmaciadelgado.example.es/start", { fetchImpl, maxRedirects: 2 })).rejects.toThrow(SafeFetchError);
  });

  it("rejects a non-HTML content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("binary", { status: 200, headers: { "content-type": "application/pdf" } }));
    await expect(safeFetchPage("https://farmaciadelgado.example.es/file.pdf", { fetchImpl })).rejects.toThrow(SafeFetchError);
  });

  it("rejects a body exceeding the content-length cap", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse("x".repeat(100)));
    await expect(safeFetchPage("https://farmaciadelgado.example.es/", { fetchImpl, maxContentLengthBytes: 10 })).rejects.toThrow(SafeFetchError);
  });

  it("rejects when DNS revalidation resolves to a private IP", async () => {
    const fetchImpl = vi.fn();
    const resolveHostname = vi.fn().mockResolvedValue(["10.0.0.1"]);
    await expect(safeFetchPage("https://farmaciadelgado.example.es/", { fetchImpl, resolveHostname })).rejects.toThrow(SafeFetchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DomainFetchCache", () => {
  it("caches a fetched page and dedupes by exact URL", () => {
    const cache = new DomainFetchCache();
    expect(cache.has("https://example.es/a")).toBe(false);
    cache.set("https://example.es/a", { url: "https://example.es/a", status: 200, contentType: "text/html", body: "x" });
    expect(cache.has("https://example.es/a")).toBe(true);
    expect(cache.get("https://example.es/a")?.body).toBe("x");
  });
});
