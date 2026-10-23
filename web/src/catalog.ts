import catalogJson from "@catalog";
import { NETWORK } from "./config";

export type ProviderId = "aws" | "azure" | "huawei" | "ccm";
export type CloudId = Exclude<ProviderId, "ccm">;
export type CategoryId =
  | "storage" | "compute" | "ai-agents" | "database" | "cdn-dns" | "backup"
  | "gpu" | "kubernetes" | "security" | "credits" | "consulting";
export type Term = "monthly" | "annual" | "hourly" | "metered" | "once";

export interface CatalogItem {
  id: string;
  provider: ProviderId;
  category: CategoryId;
  service: string;
  plan: string;
  specs: Record<string, string | number | boolean>;
  regions: string[];
  price_usd_month?: string;
  price_usd_hour?: string;
  price_usd?: string;
  credits_usd?: string;
  contract_months: number;
}

export interface Bundle {
  id: string;
  name: string;
  profile: string;
  description: string;
  discount_pct: string;
  components: Array<{ category: CategoryId; plan: string }>;
}

export interface Catalog {
  version: number;
  currency: "USD";
  price_scale?: Record<string, string>;
  discounts?: { annual_prepay_pct: string; bundle_pct: string };
  providers: Array<{ id: CloudId; name: string; full_name: string; tagline: string; regions: Array<{ id: string; name: string }> }>;
  categories: Array<{ id: CategoryId; name: string; description: string }>;
  bundles?: Bundle[];
  items: CatalogItem[];
}

/** Same file the agent prices from (app/agent/catalog.json). Display only —
 *  the binding price always comes from the agent's signed quote. */
export const CATALOG = catalogJson as unknown as Catalog;
export const CLOUDS: CloudId[] = ["aws", "azure", "huawei"];

export const findItem = (id: string) => CATALOG.items.find((i) => i.id === id) ?? null;
export const providerOf = (id: string) => CATALOG.providers.find((p) => p.id === id) ?? null;
export const categoryOf = (id: string) => CATALOG.categories.find((c) => c.id === id) ?? null;
export const providerName = (id: string) => (id === "ccm" ? "CloudCryptoMarket" : providerOf(id)?.name ?? id);

export function regionName(providerId: string, regionId: string): string {
  if (regionId === "global") return "Global";
  return providerOf(providerId)?.regions.find((r) => r.id === regionId)?.name ?? regionId;
}

export function termsFor(item: CatalogItem): Term[] {
  const t: Term[] = [];
  if (item.price_usd_month !== undefined) t.push("monthly", "annual");
  if (item.price_usd_hour !== undefined) t.push("hourly", "metered");
  if (item.price_usd !== undefined) t.push("once");
  return t;
}

export function defaultQty(item: CatalogItem, term: Term): number {
  return term === "monthly" ? item.contract_months : term === "annual" ? 12 : term === "hourly" ? 24 : term === "metered" ? 0 : 1;
}

export const TERM_LABEL: Record<Term, string> = {
  monthly: "Mensual",
  annual: "Anual prepago (−10%)",
  hourly: "Por horas (prepago)",
  metered: "Pago por uso (créditos)",
  once: "Pago único",
};

const SPEC_LABELS: Record<string, string> = {
  capacity_gb: "Capacidad", storage_class: "Clase", tier: "Nivel", egress_gb_included: "Egreso incluido",
  instance_type: "Tipo", instance_class: "Instancia", vcpu: "vCPU", memory_gb: "RAM", disk_gb: "Disco", os: "Sistema",
  agents: "Agentes", invocations_month: "Invocaciones/mes", memory: "Memoria", model: "Modelo", gateway: "Gateway",
  private_networking: "Red privada", storage_gb: "Almacenamiento", high_availability: "Alta disponibilidad",
  traffic_tb_month: "Tráfico/mes", dns_zones: "Zonas DNS", https: "HTTPS", retention_days: "Retención",
  protected_gb: "Datos protegidos", schedule: "Frecuencia", cross_region_copy: "Copia a otra región",
  gpu: "GPU", gpu_memory_gb: "Memoria GPU", nodes: "Nodos", node_type: "Tipo de nodo",
  managed_control_plane: "Control plane gestionado", rules: "Reglas", requests_million: "Millones de req.",
  protected_resources: "Recursos protegidos", response_team: "Equipo de respuesta", resources: "Recursos auditados",
  standards: "Estándares", credits_usd: "Créditos", bonus_pct: "Bonus", hours: "Horas", rate_usd_hour: "Tarifa",
  entrega: "Entrega",
};
const GB_KEYS = new Set(["capacity_gb", "egress_gb_included", "memory_gb", "disk_gb", "storage_gb", "gpu_memory_gb", "protected_gb"]);

export function specList(item: CatalogItem): Array<[string, string]> {
  return Object.entries(item.specs).map(([k, v]) => {
    let value = String(v);
    if (typeof v === "boolean") value = v ? "Sí" : "No";
    else if (GB_KEYS.has(k) && typeof v === "number") value = v >= 1024 && k === "capacity_gb" ? `${v / 1024} TB` : `${v.toLocaleString("es")} GB`;
    else if (k === "traffic_tb_month") value = `${v} TB`;
    else if (k === "retention_days") value = `${v} días`;
    else if (k === "credits_usd") value = usd(String(v));
    else if (k === "bonus_pct") value = `${v}%`;
    else if (k === "rate_usd_hour") value = `${usd(String(v))}/h`;
    else if (typeof v === "number") value = v.toLocaleString("es");
    return [SPEC_LABELS[k] ?? k, value];
  });
}

/** Price multiplier for the active network (testnet: cheap test purchases). */
export const PRICE_SCALE = CATALOG.price_scale?.[NETWORK] ?? "1";
export const IS_SCALED = PRICE_SCALE !== "1";
export const scaled = (listUsd: string | undefined) => (listUsd === undefined ? undefined : String(Number(listUsd) * Number(PRICE_SCALE)));

/** Headline price of an item at its primary term (display only). */
export function headline(item: CatalogItem): { value: string; unit: string; list: string } {
  if (item.price_usd_month !== undefined) return { value: scaled(item.price_usd_month)!, unit: "/mes", list: item.price_usd_month };
  if (item.price_usd_hour !== undefined) return { value: scaled(item.price_usd_hour)!, unit: "/hora", list: item.price_usd_hour };
  return { value: scaled(item.price_usd)!, unit: "", list: item.price_usd ?? "0" };
}

/** Back-compat helper used by older components. */
export function monthlyPrice(item: CatalogItem): string {
  return headline(item).value;
}

export function usd(value: string | number | undefined | null): string {
  const n = Number(value ?? 0);
  const digits = n !== 0 && Math.abs(n) < 1 ? 6 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

/** Item that fills a bundle component for a provider. */
export function bundleItem(provider: CloudId, c: { category: CategoryId; plan: string }): CatalogItem | null {
  return CATALOG.items.find((i) => i.provider === provider && i.category === c.category && i.plan === c.plan) ?? null;
}

export function bundleRegions(bundle: Bundle, provider: CloudId): string[] {
  const sets = bundle.components.map((c) => bundleItem(provider, c)?.regions ?? []);
  return (sets[0] ?? []).filter((r) => sets.every((s) => s.includes(r)));
}
