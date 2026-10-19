import { describe, expect, it } from "vitest";
import { extractCandidateEmails, extractCandidateEmailsWithDiagnostics } from "./email-extraction";

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

  it("reports malformed and duplicate candidates without retaining them in diagnostics", () => {
    const result = extractCandidateEmailsWithDiagnostics(
      "info@farmaciadelgado.es info@farmaciadelgado.es bad..name@farmaciadelgado.es",
      "https://farmaciadelgado.es/",
    );

    expect(result.emails).toHaveLength(1);
    expect(result.rejectedFormat).toBe(1);
    expect(result.duplicates).toBe(1);
  });

  it("dedupes a literal and a deobfuscated form of the same email", () => {
    const result = extractCandidateEmailsWithDiagnostics(
      "info@farmaciadelgado.es and info [at] farmaciadelgado [dot] es",
      "https://farmaciadelgado.es/contacto",
      "website",
      { allowEncodedAndObfuscated: true },
    );

    expect(result.emails).toHaveLength(1);
    expect(result.literalFound).toBe(1);
    expect(result.deobfuscatedFound).toBe(1);
  });

  it("extracts HTML-entity encoded email characters", () => {
    const result = extractCandidateEmailsWithDiagnostics(
      "<p>info&#64;farmaciadelgado&#46;es</p> <a href=\"mailto:ventas&commat;farmaciadelgado&period;es\">Email</a>",
      "https://farmaciadelgado.es/contacto",
      "website",
      { allowEncodedAndObfuscated: true },
    );

    expect(result.emails.map((email) => email.email).sort()).toEqual([
      "info@farmaciadelgado.es",
      "ventas@farmaciadelgado.es",
    ]);
    expect(result.deobfuscatedFound).toBe(2);
  });

  it.each([
    "info @ farmaciadelgado.es",
    "info [at] farmaciadelgado [dot] es",
    "info (at) farmaciadelgado (dot) es",
  ])("extracts a high-confidence obfuscated email: %s", (text) => {
    const result = extractCandidateEmailsWithDiagnostics(
      text,
      "https://farmaciadelgado.es/contacto",
      "website",
      { allowEncodedAndObfuscated: true },
    );

    expect(result.emails.map((email) => email.email)).toEqual(["info@farmaciadelgado.es"]);
    expect(result.deobfuscatedFound).toBe(1);
  });

  it("rejects malformed obfuscation and asset-like values", () => {
    const result = extractCandidateEmailsWithDiagnostics(
      "info [at] farmaciadelgado [dot] ; logo [at] 2x [dot] png",
      "https://farmaciadelgado.es/contacto",
      "website",
      { allowEncodedAndObfuscated: true },
    );

    expect(result.emails).toHaveLength(0);
  });

  it("keeps non-website callers on literal extraction unless safe variants are enabled", () => {
    const emails = extractCandidateEmails(
      "info [at] farmaciadelgado [dot] es",
      "https://farmaciadelgado.es/contacto",
      "serper_snippet",
    );

    expect(emails).toHaveLength(0);
  });
});
