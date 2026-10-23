/**
 * `recommend_provider` — read-only cost advisor (the demo's star skill).
 *
 *   1. Requirements: the LLM extracts a structured profile from the free-text
 *      workload description; a deterministic rule parser is the fallback (and
 *      fills fields the LLM left empty).
 *   2. Matching (deterministic, no LLM): for each provider, the cheapest
 *      catalog item that satisfies each requirement → priced with the same
 *      engine as quotes (catalog.ts › priceCart).
 *   3. Recommendation: the cheapest provider wins (deterministic); the LLM only
 *      writes the reasoning text (rule-based text if the LLM is unavailable).
 *
 * Never signs, never quotes bindingly, never moves money: the returned `cart`
 * is just suggested lines the buyer can send to `negotiate`.
 */

import { generateText } from "ai";
import { z } from "zod";
import {
  type CatalogItem,
  type CloudProviderId,
  type OrderLine,
  loadCatalog,
  priceCart,
} from "./catalog.js";
import { sellerPricing } from "./pricing.js";

const CLOUDS: CloudProviderId[] = ["aws", "azure", "huawei"];

const RequirementsSchema = z.object({
  storage_gb: z.number().positive().nullable().default(null),
  vcpu: z.number().positive().nullable().default(null),
  memory_gb: z.number().positive().nullable().default(null),
  compute: z.boolean().nullable().default(null),
  database: z.enum(["S", "M", "L"]).nullable().default(null),
  cdn_tb: z.number().positive().nullable().default(null),
  gpu: z.enum(["Inferencia", "Entrenamiento"]).nullable().default(null),
  kubernetes_nodes: z.number().int().positive().nullable().default(null),
  ai_agents: z.enum(["Starter", "Pro", "Enterprise"]).nullable().default(null),
  backup_days: z.number().int().positive().nullable().default(null),
  security: z.array(z.enum(["WAF", "Anti-DDoS", "Auditoría"])).default([]),
  region: z.enum(["latam", "us", "europe", "asia"]).nullable().default(null),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

// ── 1a. deterministic rule parser (es/en) ──────────────────────────────────

function num(s: string): number {
  return Number(s.replace(",", "."));
}

export function heuristicRequirements(text: string): Requirements {
  const t = text.toLowerCase();
  const r: Requirements = RequirementsSchema.parse({});
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(tb|gb)\b([^.,;]{0,25})/g)) {
    const gb = num(m[1]!) * (m[2] === "tb" ? 1024 : 1);
    const ctx = `${t.slice(Math.max(0, (m.index ?? 0) - 15), m.index)} ${m[3]}`;
    if (/ram|memoria|memory/.test(ctx)) r.memory_gb = gb;
    else if (/tr[aá]fico|traffic|transfer|egress|cdn/.test(ctx)) r.cdn_tb = gb / 1024;
    else r.storage_gb = Math.max(r.storage_gb ?? 0, gb);
  }
  const cpu = /(\d+)\s*(v?cpus?|cores?|n[uú]cleos)/.exec(t);
  if (cpu) r.vcpu = Number(cpu[1]);
  if (r.vcpu || r.memory_gb || /\b(app|aplicaci[oó]n|web|servidor|server|api|backend|sitio|tienda|e-?commerce)\b/.test(t)) r.compute = true;
  if (/base(s)? de datos|database|\bdb\b|postgres|mysql|\bsql\b|mongo/.test(t)) {
    r.database = /grande|large|cr[ií]tic|alta disponibilidad|high availability|enterprise/.test(t) ? "L"
      : /mediana|medium|moderad/.test(t) ? "M" : "S";
  }
  if (r.cdn_tb === null && /tr[aá]fico|traffic|cdn|visitas|usuarios|users/.test(t)) {
    r.cdn_tb = /muy alto|masivo|very high|millones|millions/.test(t) ? 50
      : /alto|high|mucho/.test(t) ? 10 : 1;
  }
  if (/gpu|entrena|training|fine-?tun|inferencia|inference|machine learning|\bml\b|llm|modelo de ia|deep learning/.test(t)) {
    r.gpu = /entrena|training|fine-?tun|deep learning/.test(t) ? "Entrenamiento" : "Inferencia";
  }
  if (/kubernetes|k8s|contenedores|containers|microservicios|microservices/.test(t)) {
    const n = /(\d+)\s*(nodos|nodes)/.exec(t);
    r.kubernetes_nodes = n ? Number(n[1]) : 3;
  }
  if (/agentes? de ia|ai agents?|agentes? inteligentes|chatbots?|asistentes? virtual/.test(t)) {
    const n = /(\d+)\s*agentes|(\d+)\s*agents/.exec(t);
    const count = n ? Number(n[1] ?? n[2]) : 1;
    r.ai_agents = count > 5 ? "Enterprise" : count > 1 ? "Pro" : "Starter";
  }
  if (/backup|respaldo|copias de seguridad|recuperaci[oó]n|disaster|\bdr\b/.test(t)) {
    const d = /(\d+)\s*d[ií]as|(\d+)\s*days/.exec(t);
    r.backup_days = d ? Number(d[1] ?? d[2]) : 30;
  }
  if (/\bwaf\b|firewall/.test(t)) r.security.push("WAF");
  if (/ddos/.test(t)) r.security.push("Anti-DDoS");
  if (/auditor|compliance|cumplimiento|normativ/.test(t)) r.security.push("Auditoría");
  if (r.security.length === 0 && /seguridad|security|segur/.test(t)) r.security.push("WAF");
  r.region = /latam|latinoam|brasil|brazil|chile|m[eé]xico|argentina|per[uú]|colombia|sudam|south america/.test(t) ? "latam"
    : /europ|espa[ñn]a|spain|alemania|germany/.test(t) ? "europe"
    : /asia|hong kong|singapur|china|jap[oó]n/.test(t) ? "asia"
    : /ee\.?\s?uu|usa|estados unidos|united states|norteam/.test(t) ? "us" : null;
  return r;
}

// ── 1b. LLM extraction (optional, validated) ───────────────────────────────

const llmEnabled = () => process.env.CCM_ADVISOR_LLM !== "0";
// The free Pieverse router (auto/free) may pick a reasoning model that is
// slow on long prompts, so LLM extraction is opt-in; the rule parser is the
// default and is deterministic.
const llmExtractEnabled = () => llmEnabled() && process.env.CCM_ADVISOR_LLM_EXTRACT === "1";
const LLM_TIMEOUT_MS = () => Number(process.env.CCM_ADVISOR_LLM_TIMEOUT_MS ?? 60_000);

async function llmModel() {
  const { buildModel } = await import("./model.js");
  return buildModel();
}

/**
 * Reasoning models may print their thinking before the answer: keep only
 * the text inside the LAST <respuesta>…</respuesta> block (null if absent).
 */
export function finalAnswer(out: string): string | null {
  const blocks = [...out.matchAll(/<respuesta>([\s\S]*?)<\/respuesta>/gi)];
  const last = blocks.at(-1)?.[1]?.trim();
  if (last) return last;
  return /thinking|razonamiento:|analy[sz]e the request/i.test(out) ? null : out.trim() || null;
}

async function llmRequirements(text: string): Promise<Partial<Requirements> | null> {
  if (!llmExtractEnabled()) return null;
  try {
    const { text: out } = await generateText({
      model: await llmModel(),
      system:
        "Extract cloud workload requirements. Put ONE JSON object between <respuesta> and </respuesta>. " +
        'Keys: storage_gb (number|null), vcpu (number|null), memory_gb (number|null), compute (boolean|null), ' +
        'database ("S"|"M"|"L"|null), cdn_tb (monthly traffic TB, number|null), gpu ("Inferencia"|"Entrenamiento"|null), ' +
        'kubernetes_nodes (int|null), ai_agents ("Starter"|"Pro"|"Enterprise"|null), backup_days (int|null), ' +
        'security (array of "WAF"|"Anti-DDoS"|"Auditoría"), region ("latam"|"us"|"europe"|"asia"|null). ' +
        'Use null when not mentioned. "tráfico alto" ≈ 10 TB, "muy alto" ≈ 50 TB, "medio" ≈ 1 TB.',
      prompt: text.slice(0, 2000),
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS()),
    });
    const json = /\{[\s\S]*\}/.exec(finalAnswer(out) ?? "")?.[0];
    if (!json) return null;
    const parsed = RequirementsSchema.partial().safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch (e) {
    console.warn("[advisor] LLM extraction unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}

// ── 2. deterministic matching ──────────────────────────────────────────────

const REGION_PREF: Record<NonNullable<Requirements["region"]> | "default", Record<CloudProviderId, string[]>> = {
  latam: { aws: ["sa-east-1"], azure: ["brazilsouth"], huawei: ["la-south-2", "la-north-2"] },
  us: { aws: ["us-east-1"], azure: ["eastus"], huawei: ["la-north-2"] },
  europe: { aws: ["eu-west-1"], azure: ["westeurope"], huawei: ["la-south-2"] },
  asia: { aws: ["us-east-1"], azure: ["eastus"], huawei: ["ap-southeast-1"] },
  default: { aws: ["us-east-1"], azure: ["eastus"], huawei: ["la-south-2"] },
};

const n = (v: unknown) => (typeof v === "number" ? v : 0);
const monthly = (i: CatalogItem) => Number(i.price_usd_month ?? "0");

interface Pick {
  item: CatalogItem;
  need: string;
  /** false → no plan meets the requirement; the largest one was chosen. */
  meets: boolean;
}

function cheapest(items: CatalogItem[], fits: (i: CatalogItem) => boolean, size: (i: CatalogItem) => number): { item: CatalogItem; meets: boolean } | null {
  if (items.length === 0) return null;
  const ok = items.filter(fits).sort((a, b) => monthly(a) - monthly(b));
  if (ok[0]) return { item: ok[0], meets: true };
  return { item: [...items].sort((a, b) => size(b) - size(a))[0]!, meets: false };
}

function picksFor(provider: CloudProviderId, r: Requirements): Pick[] {
  const items = loadCatalog().items.filter((i) => i.provider === provider);
  const cat = (c: string) => items.filter((i) => i.category === c);
  const out: Pick[] = [];
  const push = (need: string, p: { item: CatalogItem; meets: boolean } | null) => { if (p) out.push({ ...p, need }); };

  if (r.storage_gb) push(`storage ≥ ${r.storage_gb} GB`, cheapest(cat("storage"), (i) => n(i.specs.capacity_gb) >= r.storage_gb!, (i) => n(i.specs.capacity_gb)));
  if (r.compute || r.vcpu || r.memory_gb) {
    const v = r.vcpu ?? 0, m = r.memory_gb ?? 0;
    push(`cómputo ≥ ${v || "-"} vCPU / ${m || "-"} GB`, cheapest(cat("compute"), (i) => n(i.specs.vcpu) >= v && n(i.specs.memory_gb) >= m, (i) => n(i.specs.vcpu)));
  }
  if (r.database) push(`base de datos ${r.database}`, cheapest(cat("database"), (i) => i.plan === r.database, () => 0));
  if (r.cdn_tb) push(`CDN ≥ ${r.cdn_tb} TB/mes`, cheapest(cat("cdn-dns"), (i) => n(i.specs.traffic_tb_month) >= r.cdn_tb!, (i) => n(i.specs.traffic_tb_month)));
  if (r.gpu) push(`GPU ${r.gpu}`, cheapest(cat("gpu"), (i) => i.plan === r.gpu, () => 0));
  if (r.kubernetes_nodes) push(`Kubernetes ≥ ${r.kubernetes_nodes} nodos`, cheapest(cat("kubernetes"), (i) => n(i.specs.nodes) >= r.kubernetes_nodes!, (i) => n(i.specs.nodes)));
  if (r.ai_agents) push(`agentes de IA ${r.ai_agents}`, cheapest(cat("ai-agents"), (i) => i.plan === r.ai_agents, () => 0));
  if (r.backup_days) push(`backup ≥ ${r.backup_days} días`, cheapest(cat("backup"), (i) => n(i.specs.retention_days) >= r.backup_days!, (i) => n(i.specs.retention_days)));
  for (const s of new Set(r.security)) push(`seguridad ${s}`, cheapest(cat("security"), (i) => i.plan === s, () => 0));
  return out;
}

function regionFor(item: CatalogItem, provider: CloudProviderId, r: Requirements): string {
  const prefs = REGION_PREF[r.region ?? "default"][provider];
  return prefs.find((p) => item.regions.includes(p)) ?? item.regions[0]!;
}

// ── 3. recommendation ─────────────────────────────────────────────────────

interface OptionSummary {
  provider_name: string;
  monthly_list_usd: string;
  unmet: string[];
  lines: Array<{ service: string; plan: string; list_usd_month?: string }>;
}

/** LLM-written justification of an already-decided recommendation (or null). */
async function llmExplain(text: string, options: OptionSummary[], best: OptionSummary, worst: OptionSummary, savings: string): Promise<string | null> {
  if (!llmEnabled()) return null;
  try {
    const table = options.map((o) => `${o.provider_name}: $${o.monthly_list_usd}/mes; ${o.lines.map((l) => `${l.service} ${l.plan} ($${l.list_usd_month})`).join(", ")}${o.unmet.length ? `; no cubre: ${o.unmet.join(", ")}` : ""}`).join("\n");
    const { text: out } = await generateText({
      model: await llmModel(),
      system:
        "Eres un asesor de costos cloud. Escribe la respuesta final en español, en 3 a 5 frases y sin listas, " +
        "entre <respuesta> y </respuesta>. La recomendación YA está decidida (proveedor más barato): " +
        "justifícala y menciona 1-2 matices (regiones, ecosistema, requisitos no cubiertos). " +
        "No inventes precios: usa solo los de la tabla.",
      prompt: `Carga: ${text}\n\nComparativa (precio de lista mensual):\n${table}\n\nRecomendado: ${best.provider_name} (ahorro $${savings}/mes vs ${worst.provider_name}).`,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS()),
    });
    const answer = finalAnswer(out);
    return answer !== null && answer.length > 40 ? answer.slice(0, 2000) : null;
  } catch (e) {
    console.warn("[advisor] LLM reasoning unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * `opts.explain = false` returns instantly with the rule-based reasoning (the
 * web then asks for the LLM text separately); A2A/MCP callers get both.
 */
export async function recommendProvider(
  description: string,
  opts: { explain?: boolean } = {},
): Promise<Record<string, unknown>> {
  const text = description.trim().slice(0, 2000);
  const rules = heuristicRequirements(text);
  const llm = await llmRequirements(text);
  const req: Requirements = RequirementsSchema.parse({
    ...rules,
    ...Object.fromEntries(Object.entries(llm ?? {}).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0))),
  });
  if (req.security.length === 0 && rules.security.length > 0) req.security = rules.security;

  const { network } = sellerPricing();
  const providerName = (p: string) => loadCatalog().providers.find((x) => x.id === p)?.name ?? p;
  const options = CLOUDS.map((provider) => {
    const picks = picksFor(provider, req);
    const lines: OrderLine[] = picks.map((p) => ({ itemId: p.item.id, region: regionFor(p.item, provider, req), term: "monthly", qty: p.item.contract_months }));
    const priced = lines.length > 0 ? priceCart(lines, null, network) : null;
    return {
      provider,
      provider_name: providerName(provider),
      lines: picks.map((p, i) => ({
        item_id: p.item.id, category: p.item.category, service: p.item.service, plan: p.item.plan,
        region: lines[i]!.region, term: "monthly", qty: lines[i]!.qty, specs: p.item.specs,
        list_usd_month: p.item.price_usd_month, need: p.need, meets: p.meets,
      })),
      monthly_list_usd: priced?.ok ? priced.price.monthly_list_usd : "0",
      total_usd: priced?.ok ? priced.price.total_usd : "0",
      price_scale: priced?.ok ? priced.price.price_scale : "1",
      unmet: picks.filter((p) => !p.meets).map((p) => p.need),
      cart: lines.map((l) => ({ item_id: l.itemId, region: l.region, term: l.term, qty: l.qty })),
    };
  });

  if (options.every((o) => o.lines.length === 0)) {
    return {
      read_only: true, description: text, requirements: req, options: [],
      recommended: null,
      reasoning: "No identifiqué requisitos concretos. Indica almacenamiento, vCPU/RAM, base de datos, tráfico, GPU, Kubernetes, backups o seguridad.",
    };
  }

  const ranked = [...options].sort((a, b) => Number(a.monthly_list_usd) - Number(b.monthly_list_usd) || a.unmet.length - b.unmet.length);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  const savings = (Number(worst.monthly_list_usd) - Number(best.monthly_list_usd)).toFixed(2);

  const categories = [...new Set(options.flatMap((o) => o.lines.map((l) => l.category)))];
  const comparison = categories.map((c) => ({
    category: c,
    ...Object.fromEntries(options.map((o) => {
      const l = o.lines.find((x) => x.category === c);
      return [o.provider, l ? `${l.service} ${l.plan} — $${l.list_usd_month}/mes` : "—"];
    })),
  }));

  const rulesReasoning =
    `${best.provider_name} es la opción más económica para esta carga: $${best.monthly_list_usd}/mes a precio de lista, ` +
    `$${savings}/mes menos que ${worst.provider_name}. ` +
    (best.unmet.length > 0 ? `Atención: no cubre por completo ${best.unmet.join(", ")}. ` : "Cubre todos los requisitos detectados. ") +
    (req.region === "latam" ? "Las tres nubes tienen región en Latinoamérica para esta selección. " : "");

  let reasoning = rulesReasoning;
  let reasoningSource: "llm" | "rules" = "rules";
  if (opts.explain !== false) {
    const llmText = await llmExplain(text, options, best, worst, savings);
    if (llmText !== null) {
      reasoning = llmText;
      reasoningSource = "llm";
    }
  }

  return {
    read_only: true,
    description: text,
    requirements: req,
    extraction: llm === null ? "reglas" : "llm + reglas",
    network,
    options,
    comparison,
    recommended: best.provider,
    savings_usd_month: savings,
    reasoning,
    reasoning_source: reasoningSource,
    cart: { provider: best.provider, lines: best.cart },
    note: "Consulta de solo lectura: para comprar, envía `cart.lines` a negotiate (precio firmado por el agente).",
  };
}
