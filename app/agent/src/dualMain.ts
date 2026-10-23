/**
 * Combined A2A-native + tunneled MCP seller entrypoint.
 *
 * This is the VALUABLE agent AND the SOLE key-holder/signer. It serves its
 * two ERC-8183 seller skills DIRECTLY over the A2A protocol on AWS Bedrock
 * AgentCore: an `@a2a-js/sdk` express app exposes the
 * agent card at `/.well-known/agent-card.json` + JSON-RPC `message/send` on
 * `0.0.0.0:9000` (`AGENT_PORT` overrides locally), plus `GET /ping` for the
 * AgentCore liveness contract. The same app also exposes stateful
 * streamable-HTTP MCP at `/mcp`; the platform gateway reaches that face
 * through the HTTP envelope-v1 tunnel.
 *
 * A2A is deliberately the one native AgentCore protocol in dual mode:
 * `HEALTHY_BUSY` on `/ping` is the only contract that keeps background A2A
 * delivery alive. AgentCore accepts one serverProtocol and one data-plane
 * port, so both faces share this A2A-native process and port.
 *
 * A2A skills (executor.ts):
 *
 *     negotiate     → read the FIXED list price → CLAMP to [min,max] → EIP-191 SIGN
 *                     the offer (no LLM, no tools) → return the signed offer (or reject)
 *     notify_funded → re-verify the funded job on-chain (fast) → ACK accepted at once,
 *                     then in the BACKGROUND: LLM work → manifest → storage →
 *                     submitResult (SIGN + broadcast). The buyer polls the chain for
 *                     the deliverable. Each notify also sweeps other FUNDED jobs
 *                     (buyer-push fallback). While background work is in flight the
 *                     `/ping` handler reports HEALTHY_BUSY so AgentCore keeps the
 *                     scale-to-zero runtime warm until it lands.
 *
 * Buyers reach this endpoint with an OAuth2 (Cognito) bearer — AgentCore A2A
 * mandates inbound auth (see agentCard.ts + `bag deploy provision-cognito`).
 *
 * ## Boundaries (do NOT cross — they are the whole point)
 *
 * - The agent does ALL deterministic SIGNING (quote-sign + submit + settle +
 *   automatic Pieverse LLM-credit auto-renew). ALL signing is FIXED code in
 *   `signing.ts` — NEVER an LLM-callable tool (money never in the LLM).
 * - The price is a FIXED list price from studio.toml (clamped before
 *   signing) — the LLM never prices; it only PRODUCES the work text in the
 *   delivery step.
 * - Chain access for the LLM is READ-ONLY tools only (`tools.ts`).
 * - `settle` (claim payment after the dispute window) is operator-driven —
 *   run `bag erc8183 settle <job_id>`; it is deliberately NOT an A2A skill.
 */

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import {
  loadStudioToml,
  type TomlTable,
} from "@bnbagent/studio-runtime/config";
import {
  ensureAltanaSessionLoaded,
  ensureKeystoreMaterialized,
  ensureTwakMaterialized,
  getWallet,
} from "@bnbagent/studio-runtime/wallet";
import {
  createEnvelopeMiddleware,
  b402SellPath,
  type B402HttpRequest,
  type B402RunWork,
  B402Seller,
  B402SellerPolicy,
} from "@bnbagent/studio-runtime/b402";
import { generateText, stepCountIs } from "ai";
import { resolveStorageMode } from "@bnbagent/studio-runtime/storage";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildAgentCard } from "./agentCard.js";
import { SellerAgentExecutor } from "./executor.js";
import { buildMcpServer } from "./mcpMain.js";
import { buildModel } from "./model.js";
import {
  requestLimitContext,
  limitCommerceOperation as limitSellOperation,
  isCommerceRateLimitError as isSellRateLimitError,
} from "./requestLimits.js";
import type { RunWork } from "./sellerCore.js";
import { LLM_READ_TOOLS } from "./tools.js";
import { erc8183Network } from "@bnbagent/studio-runtime/erc8183";
import { recommendProvider } from "./advisor.js";
import { toMicro } from "./catalog.js";
import { credit } from "./credits.js";
import { creditsBalance, getOrderStatus, getQuote, listCatalog } from "./marketTools.js";
import { startMeter } from "./meter.js";
import {
  credentialsMessage,
  executeCreditPurchase,
  orderCredentials,
  ordersForBuyer,
  quoteCreditPurchase,
} from "./orders.js";
import { type OrderInput, sellerPricing } from "./pricing.js";

const APP_NAME = "agent";

/**
 * Deliverable `generator` label: this seller's own name, read from
 * studio.toml `[project].name` (minus the `-agent` suffix) so each delivered
 * manifest is self-identifying. Best-effort — falls back to `APP_NAME` if
 * the config can't be read.
 */
function generatorTag(): string {
  let name = "";
  try {
    const cfg = loadStudioToml();
    name = String(((cfg.project ?? {}) as Record<string, unknown>).name ?? "");
  } catch {
    // a metadata label must never break delivery
    return APP_NAME;
  }
  return name.endsWith("-agent")
    ? name.slice(0, -"-agent".length)
    : name || APP_NAME;
}

// ── Runtime secrets ───────────────────────────────────────────────────────────
// Keep plaintext secrets OUT of agentcore.json. When BNBAGENT_RUNTIME_SECRET_ID
// is set (deployed runtime), pull a JSON {ENV_NAME: value} blob from AWS
// Secrets Manager into the process env BEFORE anything reads it (keystore
// unlock, provider key, buildModel, Cognito OAuth env). No-op locally, where
// .env.local already populated the environment. In a deployed runtime the
// managed secret bundle is authoritative and replaces any stale spec-level
// value left by an earlier runtime revision.
async function loadRuntimeSecrets(): Promise<void> {
  const secretId = process.env.BNBAGENT_RUNTIME_SECRET_ID;
  if (!secretId) {
    return;
  }
  const resp = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const bundle = JSON.parse(resp.SecretString ?? "{}") as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(bundle)) {
    process.env[key] = String(value);
  }
  const pieverseKey = process.env.PIEVERSE_LLM_API_KEY;
  if (pieverseKey) {
    const fingerprint = createHash("sha256")
      .update(pieverseKey, "utf-8")
      .digest("hex")
      .slice(0, 12);
    console.info(
      `[runtime-secrets] PIEVERSE_LLM_API_KEY source=secretsmanager sha256=${fingerprint}…`,
    );
  }
}

/** studio.toml `[network].default` (best-effort; used by the funded sweep). */
function defaultNetwork(): string {
  try {
    const cfg = loadStudioToml();
    return String(
      ((cfg.network ?? {}) as Record<string, unknown>).default ?? "bsc-testnet",
    );
  } catch {
    return "bsc-testnet";
  }
}

// ── One-shot LLM helper (the executor's delivery work hook) ──────────────────
// LLM credit auto-renew (Pieverse path): `buildModel()` (in model.ts) returns
// a model wrapped with a middleware that auto-tops up the active Pieverse key
// before each generate call when [llm.auto_renew] is enabled. That top-up is
// the ONLY automatic signing path outside signing.ts — it is budget-gated and
// is NOT an LLM tool. It rides transparently into the delivery step.
//
// The LLM runs only in an authorized value step: verified ERC-8183 delivery
// or x402 work after its payment/free gate. `negotiate` is rule-based and
// never touches the LLM. The read-only chain tools are
// attached so the work can read on-chain context if it needs to — drop them
// from `tools.ts` if your work doesn't read chain. Signing / settle are NEVER
// tools — they are fixed code in signing.ts, triggered by the A2A skills,
// never callable by the LLM. (The one deliberate exception: the x402-buyer
// recipe's PAID fetch tools — see the `tools:` note below — the LLM picks the
// URL, but who gets paid and the per-call/daily caps stay locked in
// studio.toml.)
export function buildRunWork(): RunWork {
  // The model is resolved LAZILY on first delivery, not at boot: a seller
  // with no provider key yet must still serve negotiate (which never calls
  // the LLM) — missing-key errors surface at notify_funded delivery time.
  let model: ReturnType<typeof buildModel> | undefined;
  return async (prompt, { abortSignal }) => {
    model ??= buildModel(); // managed model with the auto-renew hook (delivery only)
    const result = await generateText({
      model,
      // CloudCryptoMarket: the LLM is ONLY a pre-sales/support assistant (the
      // x402 face). It never prices, signs or provisions — quotes come from
      // negotiate (catalog + signing.ts) and delivery from fulfillment/.
      system:
        "You are the CloudCryptoMarket support assistant. CloudCryptoMarket sells " +
        "AWS, Azure and Huawei Cloud services (storage, compute, AI agents) paid " +
        "in stablecoins (U, USDC, USDT) on BNB Chain via ERC-8183 escrow. " +
        "Answer the user's question concretely and concisely, in the user's " +
        "language. Use list_catalog / get_quote for products and prices and " +
        "order_status for orders — never invent a price, an item or an order " +
        "state. You cannot sign, quote bindingly, take payment or provision: " +
        "tell buyers to request a signed quote with negotiate { item_id, region, " +
        "asset } or use the web checkout. Never ask for private keys or seed phrases.",
      prompt,
      // LLM_READ_TOOLS = read-only chain tools (wallet, balances,
      // ERC-8004/8183 queries). Edit `tools.ts` to add/remove. These are
      // READ-ONLY — the agent never signs via a tool; all signing is in
      // signing.ts (fixed code).
      // To let the agent BUY paid data at work time (e.g. CMC market data
      // after `bag x402 trust cmc` + `bag recipe code x402-buyer`), spread
      // the emitted tool set — payee + per-call/daily caps stay locked in
      // studio.toml:
      //   import { X402_BUYER_TOOLS } from "./x402Buyer.js";
      //   tools: { ...LLM_READ_TOOLS, ...X402_BUYER_TOOLS },
      tools: LLM_READ_TOOLS,
      stopWhen: stepCountIs(8), // bounded tool-call loop, then final text
      abortSignal,
    });
    return result.text.trim();
  };
}

function hasErc8183Rail(cfg: TomlTable): boolean {
  const payments = asTable(cfg.payments);
  const rail = asTable(payments?.erc8183);
  return rail !== null && rail.enabled !== false;
}

function asTable(value: unknown): TomlTable | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as TomlTable)
    : null;
}

function flatHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") out[name] = value;
    else if (value !== undefined) out[name] = value[0] ?? "";
  }
  return out;
}

function flatQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * x402 face: each request is already PAID (B402 settles before work).
 *   body {"action":"credits_topup"} → credit the payer wallet with the paid
 *     x402 price (small top-ups of prepaid credits; no LLM, no signing).
 *   anything else → the support assistant (LLM, read-only tools).
 */
function b402Work(runWork: RunWork, cfg: TomlTable): B402RunWork {
  const paidUsd = B402SellerPolicy.fromToml(cfg).priceUsd;
  return async ({ prompt, payer }) => {
    let action: unknown;
    try {
      action = (JSON.parse(prompt) as Record<string, unknown>)?.action;
    } catch {
      action = undefined;
    }
    if (action === "credits_topup") {
      if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) {
        return JSON.stringify({ error: "payer address unavailable; top-up not applied" });
      }
      const ref = `x402-${randomUUID()}`;
      credit(payer, toMicro(paidUsd), "recarga x402", ref);
      return JSON.stringify({ ok: true, credited_usd: paidUsd, ref, balance: creditsBalance(payer).balance_usd });
    }
    return runWork(prompt, { sessionId: "b402" });
  };
}

// ── CloudCryptoMarket storefront API (read-only + buyer-proven credentials) ──
// The web storefront negotiates and notifies over A2A JSON-RPC like any other
// buyer agent; these REST routes only serve catalog/price/status reads and
// the wallet-signature-gated credentials read. Nothing here signs or spends.

const STOREFRONT_ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function corsForStorefront(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const origin = req.headers.origin;
  if (origin !== undefined && STOREFRONT_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
  }
  next();
}

function parseOrderRef(raw: string): number | string | null {
  if (/^\d{1,18}$/.test(raw)) return Number(raw);
  return /^cr-[0-9a-f-]{36}$/.test(raw) ? raw : null;
}

function storefrontApi(): express.Router {
  const r = express.Router();
  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
    (req: express.Request, res: express.Response) => {
      Promise.resolve(fn(req, res)).catch((e) => {
        console.error("[storefront-api] ERROR", e instanceof Error ? e.message : e);
        res.status(502).json({ error: "temporarily unavailable; retry" });
      });
    };

  r.get("/config", wrap((_req, res) => {
    const pricing = sellerPricing();
    const domain = erc8183Network(pricing.network);
    res.json({
      network: pricing.network,
      chain_id: pricing.chainId,
      provider: getWallet().address,
      assets: pricing.assets,
      commerce: domain.commerceContract,
      router: domain.routerContract,
      policy: domain.policyContract,
    });
  }));
  r.get("/catalog", wrap((req, res) => {
    res.json(
      listCatalog({
        provider: typeof req.query.provider === "string" ? req.query.provider : undefined,
        category: typeof req.query.category === "string" ? req.query.category : undefined,
      }),
    );
  }));
  r.get("/quote/:itemId", wrap((req, res) => {
    const q = getQuote({
      item_id: String(req.params.itemId),
      region: typeof req.query.region === "string" ? req.query.region : undefined,
      term: typeof req.query.term === "string" ? req.query.term : undefined,
      qty: typeof req.query.qty === "string" ? Number(req.query.qty) : undefined,
    });
    res.status("error" in q ? 404 : 200).json(q);
  }));
  // Unsigned cart / bundle preview (same engine as the signed quote).
  r.post("/quote", wrap((req, res) => {
    const q = getQuote((req.body ?? {}) as OrderInput);
    res.status("error" in q ? 400 : 200).json(q);
  }));
  // Read-only cost advisor (catalog + LLM reasoning; never signs).
  r.post("/recommend", wrap(async (req, res) => {
    const description = String((req.body as Record<string, unknown>)?.description ?? "").trim();
    if (description.length < 3 || description.length > 2000) {
      res.status(400).json({ error: "description (3-2000 chars) required" });
      return;
    }
    try {
      await limitSellOperation("recommend");
    } catch (e) {
      res.status(isSellRateLimitError(e) ? 429 : 503).json({ error: "advisor busy; retry" });
      return;
    }
    // explain=false → instant deterministic comparison; the web then calls
    // again with explain=true to get the (slower) LLM-written reasoning.
    const explain = (req.body as Record<string, unknown>)?.explain !== false;
    res.json(await recommendProvider(description, { explain }));
  }));
  // Prepaid credits: balance (public, like an on-chain balance) and
  // credit-funded purchases authorised by a buyer wallet signature.
  r.get("/credits/:buyer", wrap((req, res) => {
    const buyer = String(req.params.buyer);
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    res.json(creditsBalance(buyer));
  }));
  r.post("/credits/quote", wrap(async (req, res) => {
    const body = (req.body ?? {}) as OrderInput & { buyer?: string };
    await limitSellOperation("credits");
    const q = quoteCreditPurchase(String(body.buyer ?? ""), body);
    res.status(q.ok ? 200 : 400).json(q.ok ? q : { error: q.reason });
  }));
  r.post("/credits/purchase", wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.nonce !== "string" || typeof body.signature !== "string") {
      res.status(400).json({ error: "nonce and signature required" });
      return;
    }
    await limitSellOperation("credits");
    const out = await executeCreditPurchase(body.nonce, body.signature);
    res.status(out.ok ? 200 : out.status).json(out.ok ? out : { error: out.error });
  }));
  r.get("/orders", wrap((req, res) => {
    const buyer = String(req.query.buyer ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      res.status(400).json({ error: "buyer=0x… address required" });
      return;
    }
    res.json({ orders: ordersForBuyer(buyer) });
  }));
  // :ref = on-chain job id (digits) or credit order id (cr-<uuid>)
  r.get("/orders/:ref", wrap(async (req, res) => {
    const ref = parseOrderRef(String(req.params.ref));
    if (ref === null) {
      res.status(400).json({ error: "invalid order id" });
      return;
    }
    const out = await getOrderStatus(ref);
    res.status("error" in out ? 404 : 200).json(out);
  }));
  r.get("/orders/:ref/credentials-message", wrap((req, res) => {
    const ref = parseOrderRef(String(req.params.ref));
    if (ref === null) {
      res.status(400).json({ error: "invalid order id" });
      return;
    }
    const issuedAt = new Date().toISOString();
    res.json({
      issued_at: issuedAt,
      message: credentialsMessage(String(ref), sellerPricing().chainId, issuedAt),
    });
  }));
  r.post("/orders/:ref/credentials", wrap(async (req, res) => {
    const ref = parseOrderRef(String(req.params.ref));
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (ref === null || typeof body.signature !== "string" || typeof body.issued_at !== "string") {
      res.status(400).json({ error: "order id, signature and issued_at required" });
      return;
    }
    const out = await orderCredentials(String(ref), {
      signature: body.signature,
      issued_at: body.issued_at,
    });
    if (!out.ok) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    res.json({ id: String(ref), lines: out.lines, credentials: out.credentials });
  }));
  return r;
}

// ── serving ───────────────────────────────────────────────────────────────────

/**
 * Build the single-port dual-face app. Tests import this builder without
 * opening a listener; the runtime entrypoint calls it once and listens on
 * AgentCore's A2A port.
 */
export async function buildDualApp(): Promise<{
  app: express.Express;
  executor: SellerAgentExecutor;
}> {
  await loadRuntimeSecrets();

  // Wallet material is NEVER bundled into the deploy artifact. `bag deploy`
  // injects it via Secrets Manager and these calls (run once at cold start,
  // before any signing) materialize it on disk. Each is a no-op for the
  // other wallet kind and locally, where the wallet already lives on disk:
  //  - evm-local: WALLET_KEYSTORE_JSON → keystore file (unlocked with WALLET_PASSWORD)
  //  - twak:      TWAK_WALLET_JSON / TWAK_CREDENTIALS_JSON → $TMPDIR/twak-home/.twak
  //               (exported as TWAK_HOME_DIR; twak reads TWAK_WALLET_PASSWORD itself)
  ensureKeystoreMaterialized();
  ensureTwakMaterialized();
  await ensureAltanaSessionLoaded();

  const cfg = loadStudioToml();
  const rails = { erc8183: hasErc8183Rail(cfg) };
  if (rails.erc8183) resolveStorageMode(cfg);
  const sellPath = b402SellPath(cfg);
  const port = Number(process.env.AGENT_PORT || "9000");
  const runWork = buildRunWork();

  // The executor backs the seller skills with signing.ts fixed code (NEVER an
  // LLM tool). The express app hosts the agent card + JSON-RPC message/send
  // on 0.0.0.0:9000 and GET /ping for AgentCore's liveness probe.
  const executor = new SellerAgentExecutor({
    runWork,
    generator: generatorTag(),
    network: defaultNetwork(),
    commerceSkills: rails.erc8183,
  });
  const agentCard = buildAgentCard({ commerceSkills: rails.erc8183 });
  const seller = await B402Seller.create({
    cfg,
    runWork: b402Work(runWork, cfg),
    walletAddress: getWallet().address,
    resourceUrl: `${
      process.env.AGENTCORE_RUNTIME_URL ?? `http://localhost:${port}`
    }${sellPath}`,
  });

  const handler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    executor,
  );

  // Hourly usage meter for credit-funded pay-as-you-go lines (+ retries).
  startMeter();

  const app = express();
  app.use(requestLimitContext);
  app.use(corsForStorefront);

  // GET /ping status fed to AgentCore: HEALTHY_BUSY while a background
  // delivery is in flight, else HEALTHY.
  //
  // notify_funded acks immediately and runs the slow work (LLM + on-chain
  // submit) in the background. Reporting HEALTHY_BUSY tells AgentCore the
  // runtime is still working, so the scale-to-zero runtime is NOT reaped on
  // idle before delivery lands (bounded by the session max-lifetime; ≤8h).
  app.get("/ping", (_req, res) => {
    res.json({ status: executor.isBusy() ? "HEALTHY_BUSY" : "HEALTHY" });
  });

  if (seller.state !== "disabled") {
    app.all(
      sellPath,
      express.text({ type: "*/*", limit: "1mb" }),
      async (req, res) => {
        const request: B402HttpRequest = {
          method: req.method,
          path: req.path,
          query: flatQuery(req.query),
          headers: flatHeaders(req.headers),
          body:
            typeof req.body === "string"
              ? req.body
              : JSON.stringify(req.body ?? ""),
        };
        try {
          await limitSellOperation("sell");
        } catch (error) {
          res.status(isSellRateLimitError(error) ? 429 : 503)
            .json({ error: "seller request limit reached" });
          return;
        }
        const out = await seller.handle(request);
        res.status(out.status).set(out.headers).send(out.body);
      },
    );
  }

  app.use(express.json({ limit: "8mb" }));
  app.use("/api", storefrontApi());
  app.use(createEnvelopeMiddleware({ port }));

  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: handler }),
  );

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;
    if (transport === undefined) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session" },
          id: null,
        });
        return;
      }
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          transports[sid] = t;
        },
      });
      t.onclose = () => {
        if (t.sessionId !== undefined) {
          delete transports[t.sessionId];
        }
      };
      await buildMcpServer({
        commerceSkills: rails.erc8183,
        runWork,
      }).connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, req.body);
  });

  app.use(
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );

  return { app, executor };
}

async function main(): Promise<void> {
  const host = process.env.AGENT_BIND_HOST || "0.0.0.0";
  const port = Number(process.env.AGENT_PORT || "9000");
  const { app } = await buildDualApp();

  // AgentCore's A2A contract is 0.0.0.0:9000. Do not honor the HTTP
  // protocol's $PORT=8080 convention here; AGENT_PORT is the local-dev /
  // rendered-container override.
  app.listen(port, host, () => {
    console.log(
      `[seller-agent] A2A native + MCP tunneled serving on ${host}:${port}`,
    );
  });
}

// Run only as an entrypoint (`node dualMain.js` / the AgentCore runtime), never
// on import — tests import the builders above without starting a server.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error("[seller-agent] fatal:", e);
    process.exit(1);
  });
}
