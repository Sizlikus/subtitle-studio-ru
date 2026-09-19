import type { Config, Context } from "@netlify/functions";
import OpenAI from "openai";

const MAX_CUES = 40;
const MAX_CHARS = 30_000;
const TRANSLATOR_MODEL = "gpt-5.6-luna";
const EDITOR_MODEL = "gpt-5.6-sol";

type Cue = { id: number; text: string; durationMs?: number; tokens?: string[] };
type Translation = { id: number; ru: string };

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function cleanText(value: unknown, max = 12_000) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function parseTranslations(content: string | null): Translation[] {
  if (!content) return [];
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  const rows = Array.isArray(parsed) ? parsed : parsed?.translations;
  if (!Array.isArray(rows)) throw new Error("AI response is not an array");
  return rows
    .filter((x: any) => Number.isFinite(Number(x?.id)) && typeof x?.ru === "string")
    .map((x: any) => ({ id: Number(x.id), ru: String(x.ru) }));
}

function missingTokens(text: string, tokens: string[] = []) {
  return tokens.filter(token => !text.includes(token));
}

function styleInstruction(styleMode: string) {
  if (styleMode === "compact") return "Keep Russian concise and speakable; shorten without losing meaning, especially for short subtitle durations.";
  if (styleMode === "balanced") return "Prefer accurate, natural contemporary Russian; preserve meaning, tone and register without unnecessary embellishment.";
  return "Adapt for Russian voice-over: natural spoken Russian, smooth word order, no calques, concise where helpful, while preserving meaning, emotion, jokes and character voice.";
}

function addressInstruction(addressMode: string) {
  if (addressMode === "informal") return "Use informal ты forms where Russian grammar requires a choice.";
  if (addressMode === "formal") return "Use polite вы forms where Russian grammar requires a choice.";
  return "Choose ты/вы from context; do not force a change when context is insufficient.";
}

async function runModel(openai: OpenAI, model: string, system: string, payload: unknown) {
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "subtitle_translations",
        strict: true,
        schema: {
          type: "object",
          properties: {
            translations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  ru: { type: "string" }
                },
                required: ["id", "ru"],
                additionalProperties: false
              }
            }
          },
          required: ["translations"],
          additionalProperties: false
        }
      }
    }
  });
  return parseTranslations(completion.choices[0]?.message?.content ?? null);
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const sourceLang = ["auto", "en", "zh"].includes(body?.sourceLang) ? body.sourceLang : "auto";
    const styleMode = ["voiceover", "balanced", "compact"].includes(body?.styleMode) ? body.styleMode : "voiceover";
    const qualityMode = body?.qualityMode === "fast" ? "fast" : "quality";
    const addressMode = ["context", "informal", "formal"].includes(body?.addressMode) ? body.addressMode : "context";
    const glossary = cleanText(body?.glossary, 6_000);
    const context = Array.isArray(body?.context) ? body.context.slice(-6).map((x: any) => ({ id: Number(x?.id), source: cleanText(x?.source, 3_000), ru: cleanText(x?.ru, 3_000) })).filter((x: any) => Number.isFinite(x.id) && x.source && x.ru) : [];
    const cues: Cue[] = Array.isArray(body?.cues) ? body.cues.slice(0, MAX_CUES).map((c: any) => ({
      id: Number(c?.id),
      text: cleanText(c?.text, 3_000),
      durationMs: Number.isFinite(Number(c?.durationMs)) ? Number(c.durationMs) : 0,
      tokens: Array.isArray(c?.tokens) ? c.tokens.filter((t: any) => typeof t === "string").slice(0, 50) : []
    })).filter(c => Number.isFinite(c.id) && c.text) : [];

    if (!cues.length) return json({ error: "Нет реплик для перевода." }, 400);
    const chars = cues.reduce((n, c) => n + c.text.length, 0);
    if (chars > MAX_CHARS) return json({ error: "Слишком большой пакет реплик." }, 413);

    const language = sourceLang === "zh" ? "Chinese" : sourceLang === "en" ? "English" : "English or Chinese, detect per cue";
    const tokenRule = "Strings like ⟦S0⟧ are protected subtitle tokens. Preserve every such token EXACTLY, unchanged, in the same relative place. Never translate, delete, duplicate or renumber them.";
    const glossaryRule = glossary ? `User glossary and direction (follow unless it conflicts with source meaning):\n${glossary}` : "No custom glossary.";
    const baseSystem = [
      "You are a professional audiovisual translator from English/Chinese into Russian.",
      `Source language: ${language}. Target language: Russian.`,
      styleInstruction(styleMode),
      addressInstruction(addressMode),
      tokenRule,
      glossaryRule,
      "Translate only spoken/subtitle content. Keep names and terminology consistent across the batch.",
      "Use Russian ё only when it improves clarity; otherwise normal editorial Russian is fine.",
      "Return ONLY a JSON object with key translations, whose value is an array of objects {id:number, ru:string}. Include every input id exactly once."
    ].join("\n\n");

    const openai = new OpenAI();

    let translations = await runModel(openai, TRANSLATOR_MODEL, baseSystem, { context, cues });
    let reviewed = 0;

    if (qualityMode === "quality") {
      const reviewSystem = [
        "You are the senior Russian subtitle editor. Review a draft translation against the source.",
        "Correct mistranslations, awkward calques, grammar, register, character voice, consistency and voice-over naturalness.",
        styleInstruction(styleMode),
        addressInstruction(addressMode),
        tokenRule,
        glossaryRule,
        "Do not add facts or explanations. Preserve protected tokens exactly.",
        "Return ONLY a JSON object with key translations, whose value is an array of {id:number, ru:string}. Include every id exactly once."
      ].join("\n\n");
      const sourceById = new Map(cues.map(c => [c.id, c]));
      const draftById = new Map(translations.map(t => [t.id, t.ru]));
      const reviewPayload = cues.map(c => ({ id: c.id, source: c.text, draft: draftById.get(c.id) || c.text, durationMs: c.durationMs }));
      const edited = await runModel(openai, EDITOR_MODEL, reviewSystem, { cues: reviewPayload });
      if (edited.length) {
        translations = edited.map(t => {
          const cue = sourceById.get(t.id);
          const draft = draftById.get(t.id) || t.ru;
          if (cue && missingTokens(t.ru, cue.tokens || []).length && !missingTokens(draft, cue.tokens || []).length) {
            return { id: t.id, ru: draft };
          }
          return { id: t.id, ru: t.ru };
        });
        reviewed = translations.filter(t => sourceById.has(t.id)).length;
      }
    }

    const byCue = new Map(cues.map(c => [c.id, c]));
    const warnings: string[] = [];
    for (const t of translations) {
      const cue = byCue.get(t.id);
      if (!cue) continue;
      const missing = missingTokens(t.ru, cue.tokens || []);
      if (missing.length) warnings.push(`Реплика ${t.id + 1}: потеряны служебные теги ${missing.join(", ")}`);
    }

    const expected = new Set(cues.map(c => c.id));
    const got = new Set(translations.map(t => t.id));
    for (const id of expected) if (!got.has(id)) warnings.push(`Реплика ${id + 1}: AI не вернул перевод`);

    return json({ translations, reviewed, warnings, models: qualityMode === "quality" ? [TRANSLATOR_MODEL, EDITOR_MODEL] : [TRANSLATOR_MODEL] });
  } catch (error: any) {
    console.error("translate error", error);
    const message = error?.status === 429 ? "Лимит AI временно исчерпан. Попробуйте чуть позже." : "Не удалось выполнить AI-перевод.";
    return json({ error: message }, error?.status === 429 ? 429 : 500);
  }
};

export const config: Config = {
  path: "/api/translate",
  rateLimit: {
    windowLimit: 8,
    windowSize: 60,
    aggregateBy: ["ip", "domain"]
  }
};
