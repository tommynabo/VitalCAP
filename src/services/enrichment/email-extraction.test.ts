import { describe, expect, it } from "vitest";
import { extractCandidateEmails } from "./email-extraction";

describe("extractCandidateEmails", () => {
  it("extracts a mailto link", () => {
    const html = '<a href="mailto:info@farmaciadelgado.es">Escríbenos</a>';
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/contacto");
    expect(emails).toHaveLength(1);
    expect(emails[0]?.email).toBe("info@farmaciadelgado.es");
    expect(emails[0]?.isGeneric).toBe(true);
  });

  it("does not auto-discard info@ addresses", () => {
    const html = "Contacta con nosotros en info@farmaciadelgado.es para más detalles.";
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/");
    expect(emails.some((e) => e.email === "info@farmaciadelgado.es")).toBe(true);
  });

  it("extracts a visible (non-mailto) email and captures surrounding context", () => {
    const html = "<p>Nuestra titular es María García, maria.garcia@farmaciadelgado.es</p>";
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/nosotros");
    expect(emails[0]?.email).toBe("maria.garcia@farmaciadelgado.es");
    expect(emails[0]?.isGeneric).toBe(false);
    expect(emails[0]?.context).toContain("María García");
  });

  it("extracts multiple distinct emails from the same page", () => {
    const html = "info@farmaciadelgado.es y compras@farmaciadelgado.es";
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/");
    expect(emails.map((e) => e.email).sort()).toEqual(["compras@farmaciadelgado.es", "info@farmaciadelgado.es"]);
  });

  it("filters out no-reply/test addresses", () => {
    const html = "noreply@farmaciadelgado.es test@farmaciadelgado.es";
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/");
    expect(emails).toHaveLength(0);
  });

  it("filters out image-filename false positives that look like an email shape", () => {
    const html = '<img src="logo@2x.png">';
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/");
    expect(emails).toHaveLength(0);
  });

  it("filters out known unrelated third-party/platform domains", () => {
    const html = "support@sentry.io webmaster@wixpress.com";
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/");
    expect(emails).toHaveLength(0);
  });

  it("dedupes the same email found via both mailto and visible text", () => {
    const html = '<a href="mailto:info@farmaciadelgado.es">info@farmaciadelgado.es</a>';
    const emails = extractCandidateEmails(html, "https://farmaciadelgado.es/");
    expect(emails).toHaveLength(1);
  });
});
