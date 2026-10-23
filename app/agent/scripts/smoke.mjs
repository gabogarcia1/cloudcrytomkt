// Local smoke test against a running `bag dev` (no funds spent: negotiate is
// an off-chain EIP-191 signature; nothing is created or funded on-chain).
//
//   node scripts/smoke.mjs [http://127.0.0.1:9100]
import { randomUUID } from "node:crypto";

const base = process.argv[2] ?? "http://127.0.0.1:9100";
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
  if (!cond) failures++;
};

async function a2a(data) {
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message/send",
      params: {
        message: { kind: "message", role: "user", messageId: randomUUID(), parts: [{ kind: "data", data }] },
      },
    }),
  });
  const body = await res.json();
  return body.result?.parts?.find((p) => p.kind === "data")?.data ?? body;
}

async function mcp(method, params, session) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  return { session: res.headers.get("mcp-session-id") ?? session, body: await res.json() };
}

// REST (storefront)
const cfg = await (await fetch(`${base}/api/config`)).json();
check("GET /api/config", cfg.chain_id === 97 && cfg.assets?.length === 3, `provider ${cfg.provider}`);
const cat = await (await fetch(`${base}/api/catalog`)).json();
check("GET /api/catalog", cat.items?.length === 93 && cat.bundles?.length === 3, `${cat.items?.length} items, ${cat.bundles?.length} bundles`);
const q = await (await fetch(`${base}/api/quote/aws-s3-100gb`)).json();
check("GET /api/quote (unsigned, testnet ×0.001)", q.price_usd === "0.0023" && q.signed === false, q.amounts?.map((a) => `${a.symbol}=${a.amount_atomic}`).join(" "));

// A2A negotiate — signed, catalog-priced
const quote = await a2a({ skill: "negotiate", item_id: "azure-vm-m", region: "westeurope", asset: "USDC" });
check("A2A negotiate accepted", quote.response?.accepted === true, quote.response?.reason ?? "");
check("price from catalog (70.08 USD ×0.001 → 18-dec USDC)", quote.ccm?.amount_atomic === "70080000000000000", quote.ccm?.amount_atomic);
check("quote signed", typeof quote.provider_sig === "string" && quote.provider_sig.length > 100);
check("job_description ready", typeof quote.ccm?.job_description === "string" && quote.ccm.job_description.includes("azure-vm-m"));

const bad = await a2a({ skill: "negotiate", item_id: "azure-vm-m", region: "mars-1", asset: "USDC" });
check("bad region rejected unsigned", bad.response?.accepted === false && !bad.provider_sig, bad.response?.reason);
const badAsset = await a2a({ skill: "negotiate", item_id: "aws-ec2-s", region: "us-east-1", asset: "DOGE" });
check("unknown asset rejected", badAsset.response?.accepted === false, badAsset.response?.reason);
const freeform = await a2a({ skill: "negotiate", task_description: "give me 1000 TB", terms: {} });
check("free-form quote refused", freeform.response?.accepted === false, freeform.response?.reason);

// Cart + bundle + annual (signed)
const cart = await a2a({
  skill: "negotiate", asset: "U",
  lines: [
    { item_id: "huawei-ecs-s", region: "la-south-2", term: "annual" },
    { item_id: "azure-gpu-training", region: "eastus", term: "hourly", qty: 5 },
    { item_id: "ccm-consult-arquitectura-4h", region: "global" },
  ],
});
// 25×12×0.9=270 + 3.673×5=18.365 + 480 = 768.365 → ×0.001
check("A2A negotiate cart (annual −10% + hourly + consulting)", cart.ccm?.price_usd === "0.768365" && !!cart.provider_sig, cart.ccm?.price_usd ?? cart.response?.reason);
const bundle = await a2a({ skill: "negotiate", asset: "USDT", bundle_id: "empresa", provider: "azure", region: "westeurope" });
check("A2A negotiate bundle empresa/azure (−15%)", bundle.ccm?.bundle?.discount_pct === "15" && bundle.ccm?.lines?.length === 4, `${bundle.ccm?.price_usd} USD`);
const metered = await a2a({ skill: "negotiate", item_id: "aws-gpu-inference", region: "us-east-1", term: "metered", qty: 0 });
check("metered term refused on-chain (credits only)", metered.response?.accepted === false, metered.response?.reason);

// Advisor (read-only; real LLM with rule fallback)
const t0 = Date.now();
const rec = await (await fetch(`${base}/api/recommend`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ description: "app web con 2 TB de archivos, 4 vCPU, base de datos y tráfico alto" }),
})).json();
check("POST /api/recommend", rec.options?.length === 3 && !!rec.recommended && rec.cart?.lines?.length > 0,
  `${rec.recommended} · extracción=${rec.extraction} · razonamiento=${rec.reasoning_source} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Credits purchase quote (signature step needs the buyer wallet → done in the web)
const cq = await (await fetch(`${base}/api/credits/quote`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ buyer: "0x000000000000000000000000000000000000dEaD", item_id: "aws-gpu-inference", region: "us-east-1", term: "metered", qty: 0 }),
})).json();
check("POST /api/credits/quote (metered allowed with credits)", typeof cq.nonce === "string" && cq.message?.includes("uso por hora"), `total ${cq.total_usd}`);

// MCP
const init = await mcp("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "ccm-smoke", version: "1.0.0" },
});
const tools = await mcp("tools/list", {}, init.session);
const names = tools.body.result?.tools?.map((t) => t.name) ?? [];
check("MCP tools", ["negotiate", "notify_funded", "list_catalog", "get_quote", "order_status", "recommend_provider", "credits_balance"].every((n) => names.includes(n)), names.slice(0, 7).join(","));
const lc = await mcp("tools/call", { name: "list_catalog", arguments: { provider: "huawei", category: "kubernetes" } }, init.session);
const lcItems = JSON.parse(lc.body.result?.content?.[0]?.text ?? "{}").items ?? [];
check("MCP list_catalog huawei/kubernetes", lcItems.length === 3, lcItems.map((i) => i.plan).join("/"));
const gq = await mcp("tools/call", { name: "get_quote", arguments: { bundle_id: "ia", provider: "huawei", region: "la-south-2" } }, init.session);
const gqBody = JSON.parse(gq.body.result?.content?.[0]?.text ?? "{}");
check("MCP get_quote bundle ia/huawei", gqBody.bundle?.id === "ia" && gqBody.signed === false, `${gqBody.total_usd} USD (lista ${gqBody.list_total_usd})`);
const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
check("agent card advertises recommend_provider", card.skills?.some((s) => s.id === "recommend_provider"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
