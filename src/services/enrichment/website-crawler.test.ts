import { describe, expect, it, vi } from "vitest";
import type { FetchedPage, WebsiteFetchOptions, WebsiteFetcher } from "@/domain/providers/types";
import { SafeFetchError } from "@/lib/security/safe-fetch";
import { crawlWebsite } from "./website-crawler";

function makeFetcher(pages: Record<string, string>): WebsiteFetcher {
  return {
    fetchPage: vi.fn(async (url: string) => {
      const body = pages[url];
      if (body === undefined) throw new Error(`unexpected fetch: ${url}`);
      return { url, status: 200, contentType: "text/html", body };
    }),
  };
}

describe("crawlWebsite", () => {
  it("always includes the homepage", async () => {
    const fetcher = makeFetcher({ "https://farmaciadelgado.es/": "<html>home</html>" });
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.body).toContain("home");
  });

  it("follows internal links matching target keywords (contacto, nosotros, aviso-legal)", async () => {
    const fetcher = makeFetcher({
      "https://farmaciadelgado.es/": '<a href="/contacto">Contacto</a><a href="/aviso-legal">Legal</a><a href="/productos">Productos</a>',
      "https://farmaciadelgado.es/contacto": "<html>contacto page: info@farmaciadelgado.es</html>",
      "https://farmaciadelgado.es/aviso-legal": "<html>Titular: María García</html>",
    });
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/");
    const urls = pages.map((p) => p.url);
    expect(urls).toContain("https://farmaciadelgado.es/contacto");
    expect(urls).toContain("https://farmaciadelgado.es/aviso-legal");
    expect(urls).not.toContain("https://farmaciadelgado.es/productos");
  });

  it("never fetches the same URL twice and respects maxPages", async () => {
    const fetcher = makeFetcher({
      "https://farmaciadelgado.es/": '<a href="/contacto">Contacto</a><a href="/contacto">Contacto again</a><a href="/equipo">Equipo</a>',
      "https://farmaciadelgado.es/contacto": "<html>contacto</html>",
      "https://farmaciadelgado.es/equipo": "<html>equipo</html>",
    });
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/", { maxPages: 2 });
    expect(pages).toHaveLength(2);
    expect(fetcher.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("targets common Spanish customer-care paths and marks the fetched contact page", async () => {
    const fetcher = makeFetcher({
      "https://farmaciadelgado.es/": '<a href="/atencion-al-cliente">Atención al cliente</a><a href="/empresa">Conócenos</a>',
      "https://farmaciadelgado.es/atencion-al-cliente": "customer care",
      "https://farmaciadelgado.es/empresa": "company page",
    });

    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/", { maxPages: 3 });

    expect(pages.map((page) => page.url)).toContain("https://farmaciadelgado.es/atencion-al-cliente");
    expect(pages.map((page) => page.url)).toContain("https://farmaciadelgado.es/empresa");
    expect(pages.find((page) => page.url.endsWith("/atencion-al-cliente"))?.contactTarget).toBe(true);
  });

  it("hard-caps the total crawl at six pages even when a caller requests more", async () => {
    const links = Array.from({ length: 8 }, (_, index) => `/contactanos/${index}`);
    const bodies = Object.fromEntries([
      ["https://farmaciadelgado.es/", links.map((path) => `<a href="${path}">Contacto</a>`).join("")],
      ...links.map((path) => [`https://farmaciadelgado.es${path}`, "contact page"]),
    ]);
    const fetcher = makeFetcher(bodies);

    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/", { maxPages: 20 });

    expect(pages).toHaveLength(6);
    expect(fetcher.fetchPage).toHaveBeenCalledTimes(6);
  });

  it("does not fail the whole crawl if one internal page is unreachable", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn(async (url: string) => {
        if (url.endsWith("/contacto")) throw new Error("network error");
        return { url, status: 200, contentType: "text/html", body: '<a href="/contacto">Contacto</a>' };
      }),
    };
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/");
    expect(pages).toHaveLength(1);
  });

  it("prioritizes Spanish contact anchor text and ignores external domains", async () => {
    const fetcher = makeFetcher({
      "https://farmaciadelgado.es/": '<a href="/products">Productos</a><a href="/page-1">Contáctanos</a><a href="https://other.example/contact">Contact</a>',
      "https://farmaciadelgado.es/page-1": "contact page",
    });
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/", { maxPages: 2 });

    expect(pages.map((page) => page.url)).toEqual([
      "https://farmaciadelgado.es/",
      "https://farmaciadelgado.es/page-1",
    ]);
    expect(fetcher.fetchPage).not.toHaveBeenCalledWith("https://other.example/contact");
    expect(fetcher.fetchPage).not.toHaveBeenCalledWith("https://farmaciadelgado.es/products");
  });

  it("recognizes about and team paths while respecting the total page budget", async () => {
    const fetcher = makeFetcher({
      "https://farmaciadelgado.es/": '<a href="/products">Productos</a><a href="/about">About us</a><a href="/equipo">Nuestro equipo</a>',
      "https://farmaciadelgado.es/about": "about page",
      "https://farmaciadelgado.es/equipo": "team page",
    });
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/", { maxPages: 3 });

    expect(pages.map((page) => page.url)).toContain("https://farmaciadelgado.es/about");
    expect(pages.map((page) => page.url)).toContain("https://farmaciadelgado.es/equipo");
    expect(pages).toHaveLength(3);
    expect(fetcher.fetchPage).not.toHaveBeenCalledWith("https://farmaciadelgado.es/products");
  });

  it("retries one transient 503 and succeeds without exceeding the attempt bound", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn()
        .mockResolvedValueOnce({ url: "https://farmaciadelgado.es/", status: 503, contentType: "text/html", body: "" })
        .mockResolvedValueOnce({ url: "https://farmaciadelgado.es/", status: 200, contentType: "text/html", body: "home" }),
    };
    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/");

    expect(pages).toHaveLength(1);
    expect(fetcher.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent SSRF failures", async () => {
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn().mockRejectedValue(new SafeFetchError("blocked hostname", "blocked_hostname")),
    };

    await expect(crawlWebsite(fetcher, "https://farmaciadelgado.es/")).rejects.toMatchObject({ reason: "blocked_hostname" });
    expect(fetcher.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("retries a connection reset once", async () => {
    const resetError = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn()
        .mockRejectedValueOnce(resetError)
        .mockResolvedValueOnce({ url: "https://farmaciadelgado.es/", status: 200, contentType: "text/html", body: "home" }),
    };

    const pages = await crawlWebsite(fetcher, "https://farmaciadelgado.es/");

    expect(pages).toHaveLength(1);
    expect(fetcher.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not swallow an abort while fetching an internal page", async () => {
    const controller = new AbortController();
    const abortReason = new Error("PROCESSING_JOB_TIMEOUT");
    const fetcher: WebsiteFetcher = {
      fetchPage: vi.fn(async (url: string, options?: WebsiteFetchOptions): Promise<FetchedPage> => {
        if (url === "https://farmaciadelgado.es/") {
          return { url, status: 200, contentType: "text/html", body: '<a href="/contacto">Contacto</a>' };
        }
        return new Promise<FetchedPage>((_resolve, reject) => {
          const rejectOnAbort = () => reject(options?.signal?.reason);
          options?.signal?.addEventListener("abort", rejectOnAbort, { once: true });
          if (options?.signal?.aborted) rejectOnAbort();
          setTimeout(() => controller.abort(abortReason), 0);
        });
      }),
    };

    await expect(crawlWebsite(fetcher, "https://farmaciadelgado.es/", { signal: controller.signal }))
      .rejects.toBe(abortReason);
  });
});
