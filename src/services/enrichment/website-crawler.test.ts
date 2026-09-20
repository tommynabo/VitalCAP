import { describe, expect, it, vi } from "vitest";
import type { WebsiteFetcher } from "@/domain/providers/types";
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
});
