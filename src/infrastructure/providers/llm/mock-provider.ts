import type { LLMProvider, SetterClassificationOutput, SetterPromptContext } from "@/domain/providers/types";
import { hashString, seededRandom } from "@/infrastructure/providers/deterministic-fixtures";

/**
 * Development mock for `LLMProvider` (Prompt 4 §4.5). No real LLM API is
 * called. Classification is a deterministic keyword classifier (reusing
 * Phase 2's `hashString`/`seededRandom` fixture pattern for confidence
 * variability) and drafting is template-based, always grounded only in the
 * whitelisted `SetterPromptContext` — never inventing facts outside it.
 *
 * `needsHuman` is set for branches where a human must originate/approve the
 * substance of the reply before any draft is useful (commercial
 * negotiation, uncertain intent, non-decision-maker handoff) — this is
 * independent of and in addition to the human-in-the-loop review that every
 * draft requires per §4.7 regardless of this flag's value.
 */

interface BranchRule {
  branch: SetterClassificationOutput["branch"];
  pattern: RegExp;
  needsHuman: boolean;
  detectedFact: string | null;
}

const BRANCH_RULES: readonly BranchRule[] = [
  { branch: "MEETING_REQUEST", pattern: /\b(reuni[oó]n|meeting|videollamada|agendar\s*(una\s*)?llamada)\b/i, needsHuman: false, detectedFact: null },
  { branch: "COMMERCIAL_TERMS", pattern: /\b(exclusiv\w*|territorio\s*exclusivo|gran\s*volumen|descuento\s*especial|custom\s*terms|large\s*volume)\b/i, needsHuman: true, detectedFact: "commercial_terms" },
  { branch: "MARGIN", pattern: /\b(margen|margin)\b/i, needsHuman: false, detectedFact: "margin" },
  { branch: "PRICE", pattern: /\b(precio|price|cu[aá]nto\s*cuesta|coste|€)\b/i, needsHuman: false, detectedFact: "price" },
  { branch: "MINIMUM_ORDER", pattern: /\b(pedido\s*m[ií]nimo|minimum\s*order|moq)\b/i, needsHuman: false, detectedFact: "minimum_order" },
  { branch: "SAMPLES", pattern: /\b(muestra\w*|sample\w*)\b/i, needsHuman: false, detectedFact: "samples" },
  { branch: "EXISTING_SUPPLIER", pattern: /\b(ya\s*(tenemos|trabajamos\s*con)\s*proveedor|current\s*supplier)\b/i, needsHuman: false, detectedFact: null },
  { branch: "CREDIBILITY", pattern: /\b(qui[eé]nes\s*sois|qui[eé]n\s*es\s*vitalcap|referencias|who\s*are\s*you|are\s*you\s*legit)\b/i, needsHuman: false, detectedFact: null },
  { branch: "LOGISTICS", pattern: /\b(env[ií]o|entrega|shipping|logistic\w*|plazo\s*de\s*entrega)\b/i, needsHuman: false, detectedFact: "shipping" },
  { branch: "NOT_DECISION_MAKER", pattern: /\b(no\s*soy\s*quien\s*decide|not\s*the\s*decision\s*maker|hablar\s*con\s*el\s*due[ñn]o)\b/i, needsHuman: true, detectedFact: null },
  { branch: "CALL_ME_LATER", pattern: /\b(ll[aá]mame\s*(m[aá]s\s*tarde|luego)|call\s*me\s*later|otro\s*momento)\b/i, needsHuman: false, detectedFact: null },
  { branch: "PRODUCT_DETAILS", pattern: /\b(ingredientes|composici[oó]n|formato\w*|product\s*details|dosis)\b/i, needsHuman: false, detectedFact: null },
  { branch: "SEND_INFO", pattern: /\b(env[ií]a(me)?\s*(m[aá]s\s*)?informaci[oó]n|send\s*(more\s*)?info)\b/i, needsHuman: false, detectedFact: null },
  { branch: "INTEREST", pattern: /\b(interes\w*|interested)\b/i, needsHuman: false, detectedFact: null },
];

const NEXT_ACTION_BY_BRANCH: Record<string, string> = {
  MEETING_REQUEST: "book_meeting",
  COMMERCIAL_TERMS: "escalate_to_sales_director",
  NOT_DECISION_MAKER: "request_decision_maker_contact",
};

function classifyBranch(message: string): { branch: SetterClassificationOutput["branch"]; needsHuman: boolean; detectedFact: string | null } {
  for (const rule of BRANCH_RULES) {
    if (rule.pattern.test(message)) {
      return { branch: rule.branch, needsHuman: rule.needsHuman, detectedFact: rule.detectedFact };
    }
  }
  return { branch: "UNKNOWN", needsHuman: true, detectedFact: null };
}

function buildCtaSentence(context: SetterPromptContext): string {
  return `¿Le viene bien que agendemos una breve llamada con nuestro director comercial? ${context.offer.bookingUrl}`;
}

function buildDraft(branch: SetterClassificationOutput["branch"], context: SetterPromptContext): string {
  const cta = buildCtaSentence(context);
  const company = context.offer.company;
  switch (branch) {
    case "MEETING_REQUEST":
      return `Perfecto, encantados de coordinar. ${cta}`;
    case "COMMERCIAL_TERMS":
      return `Gracias por el detalle. Para condiciones especiales lo mejor es que hable directamente con nuestro director comercial. ${cta}`;
    case "MARGIN":
      return `Gracias por su interés en el margen de ${company}. Nuestro director comercial puede darle el detalle exacto. ${cta}`;
    case "PRICE":
      return `Gracias por su interés. Para compartir precios y condiciones concretas, lo mejor es una breve llamada. ${cta}`;
    case "MINIMUM_ORDER":
      return `Gracias por preguntar por el pedido mínimo. Con gusto lo revisamos en una breve llamada. ${cta}`;
    case "SAMPLES":
      return `Podemos valorar el envío de muestras. ${cta}`;
    case "EXISTING_SUPPLIER":
      return `Entendido, muchas gracias por contarnos su situación actual. Si en algún momento quiere comparar opciones, aquí estamos. ${cta}`;
    case "CREDIBILITY":
      return `Somos ${company}, trabajamos con farmacias en toda España. Con gusto le compartimos referencias en una breve llamada. ${cta}`;
    case "LOGISTICS":
      return `Gracias por su pregunta sobre envío/logística. Podemos darle el detalle exacto en una breve llamada. ${cta}`;
    case "CALL_ME_LATER":
      return `Por supuesto, le contactamos más adelante. Mientras tanto, aquí tiene el enlace por si prefiere agendar usted mismo: ${context.offer.bookingUrl}`;
    case "PRODUCT_DETAILS":
      return `Gracias por su interés en el producto. Con gusto le damos el detalle completo en una breve llamada. ${cta}`;
    case "SEND_INFO":
      return `Con gusto le enviamos más información. ${cta}`;
    case "INTEREST":
      return `Gracias por su interés en ${company}. ${cta}`;
    default:
      return `Gracias por su mensaje, lo revisamos con el equipo y le contactamos en breve.`;
  }
}

export class MockLLMProvider implements LLMProvider {
  readonly providerName = "mock-llm";

  async classifyAndDraft(context: SetterPromptContext): ReturnType<LLMProvider["classifyAndDraft"]> {
    const { branch, needsHuman, detectedFact } = classifyBranch(context.latestIncomingMessage);
    const roll = seededRandom(hashString(`${context.latestIncomingMessage}:${branch}`))();
    const confidence = Math.round((0.6 + roll * 0.35) * 100) / 100;

    const output: SetterClassificationOutput = {
      language: context.language,
      branch,
      intentSummary: `Lead message classified as ${branch}`,
      confidence,
      draft: buildDraft(branch, context),
      needsHuman,
      reasonForHuman: needsHuman ? `Branch "${branch}" requires human judgment before any reply is sent.` : null,
      detectedFactsRequested: detectedFact ? [detectedFact] : [],
      riskFlags: [],
      suggestedNextAction: NEXT_ACTION_BY_BRANCH[branch] ?? "await_human_review",
    };

    return {
      output,
      usage: { calls: 1, items: 1, errors: 0, totalLatencyMs: 120, costUsd: 0, quotaRemaining: null },
    };
  }
}
