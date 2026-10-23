import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatUnits } from "viem";
import { useAccount, useChainId, useConfig, useSignMessage, useSwitchChain } from "wagmi";
import {
  type ItemQuote,
  type QuotePreview,
  type UiStatus,
  creditsBalance,
  creditsPurchase,
  creditsQuote,
  negotiate,
  notifyFunded,
  orderStatus,
  previewQuote,
} from "../agent";
import { cartStore, orderPayload, useCart } from "../cart";
import {
  CATALOG,
  IS_SCALED,
  PRICE_SCALE,
  TERM_LABEL,
  type Term,
  bundleItem,
  bundleRegions,
  defaultQty,
  findItem,
  providerName,
  regionName,
  termsFor,
  usd,
} from "../catalog";
import { STEP_LABELS, type StepId, orderSummary, purchase, tokenBalance } from "../checkout";
import { StatusBadge } from "../components/StatusBadge";
import { short } from "../components/WalletButton";
import { CHAIN, addressUrl, txUrl } from "../config";
import { saveLocalOrder } from "../localOrders";
import { APP_CHAIN_ID } from "../wagmi";

const ASSETS = ["U", "USDT", "USDC"] as const;
type StepState = "wallet" | "mining" | "done" | "skipped";
type PayMethod = "chain" | "credits";

export function Cart() {
  const cart = useCart();
  const navigate = useNavigate();
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { signMessageAsync } = useSignMessage();

  const [method, setMethod] = useState<PayMethod>("chain");
  const [asset, setAsset] = useState<(typeof ASSETS)[number]>("U");
  const [preview, setPreview] = useState<QuotePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [quote, setQuote] = useState<ItemQuote | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [credits, setCredits] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<Partial<Record<StepId, { state: StepState; hash?: string }>>>({});
  const [orderRef, setOrderRef] = useState<string | null>(null);
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const payload = useMemo(() => orderPayload(cart), [cart]);
  const payloadKey = JSON.stringify(payload);
  const hasMetered = cart.lines.some((l) => l.term === "metered");
  const hasCreditPack = cart.lines.some((l) => findItem(l.item_id)?.category === "credits");
  const empty = !cart.bundle && cart.lines.length === 0;

  useEffect(() => { const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { setQuote(null); setError(null); }, [payloadKey, asset, method]);
  useEffect(() => { if (hasMetered) setMethod("credits"); }, [hasMetered]);
  useEffect(() => { if (hasCreditPack) setMethod("chain"); }, [hasCreditPack]);

  // Live unsigned preview (same engine as the signed quote).
  useEffect(() => {
    if (empty) { setPreview(null); return; }
    const t = setTimeout(() => {
      previewQuote(payload).then((p) => { setPreview(p); setPreviewError(null); }).catch((e) => { setPreview(null); setPreviewError(e instanceof Error ? e.message : String(e)); });
    }, 250);
    return () => clearTimeout(t);
  }, [payloadKey, empty]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!address) { setCredits(null); return; }
    creditsBalance(address).then((c) => setCredits(c.balance_usd)).catch(() => setCredits(null));
  }, [address, status]);

  useEffect(() => {
    if (!quote || !address) { setBalance(null); return; }
    tokenBalance(config, quote.asset.address, address).then(setBalance).catch(() => setBalance(null));
  }, [quote, address, config]);

  useEffect(() => {
    if (orderRef === null || status === "provisionado" || status === "fallido") return;
    const t = setInterval(async () => {
      try { setStatus((await orderStatus(orderRef)).status); } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [orderRef, status]);

  if (empty && orderRef === null) {
    return (
      <div className="panel">
        <h1>Carrito</h1>
        <p>Tu carrito está vacío. Explora los <Link to="/">proveedores</Link>, los <Link to="/#paquetes">paquetes</Link> o pídele una propuesta al <Link to="/asesor">asesor de costos</Link>.</p>
      </div>
    );
  }

  const expired = quote !== null && quote.quote_expires_at > 0 && quote.quote_expires_at <= now + 60;
  const insufficient = quote !== null && balance !== null && balance < BigInt(quote.amount_atomic);
  const creditsShort = preview !== null && credits !== null && Number(credits) < Number(preview.total_usd);
  const locked = busy || orderRef !== null;

  async function requestQuote() {
    setBusy(true); setError(null);
    try { setQuote(await negotiate(payload, asset)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function payChain() {
    if (!quote || !address) return;
    setBusy(true); setError(null); setSteps({});
    try {
      const { jobId } = await purchase(config, address, quote, (step, state, hash) =>
        setSteps((s) => ({ ...s, [step]: { state, hash: hash ?? s[step]?.hash } })));
      setOrderRef(jobId.toString());
      setStatus("pagado");
      cartStore.clear();
      const ack = await notifyFunded(jobId);
      if (ack.status === "rejected") setError(`El agente rechazó el job: ${String(ack.reason ?? ack.error)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/User rejected|denied/i.test(msg) ? "Firma cancelada en la wallet." : msg.split("\n")[0] ?? msg);
    } finally {
      setBusy(false);
    }
  }

  async function payCredits() {
    if (!address || !preview) return;
    setBusy(true); setError(null);
    try {
      const q = await creditsQuote(address, payload);
      const signature = await signMessageAsync({ message: q.message });
      const { group_id } = await creditsPurchase(q.nonce, signature);
      saveLocalOrder({
        jobId: group_id, payment: "credits", summary: orderSummary(preview), buyer: address,
        itemId: preview.lines[0]?.itemId ?? "", region: preview.lines[0]?.region ?? "",
        symbol: "créditos", decimals: 6, token: "credits", amountAtomic: String(Math.round(Number(q.total_usd) * 1e6)),
        priceUsd: q.total_usd, quoteExpiresAt: 0, txs: {}, createdAt: new Date().toISOString(),
      });
      setOrderRef(group_id);
      setStatus("pagado");
      cartStore.clear();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/User rejected|denied/i.test(msg) ? "Firma cancelada en la wallet." : msg.split("\n")[0] ?? msg);
    } finally {
      setBusy(false);
    }
  }

  const stepOrder: StepId[] = ["create", "register", "budget", "approve", "fund"];
  const bundle = cart.bundle ? CATALOG.bundles?.find((b) => b.id === cart.bundle!.id) ?? null : null;

  return (
    <>
      <div className="page-head">
        <h1>Carrito</h1>
        {cart.source && <span className="pill">Origen: {cart.source}</span>}
      </div>
      <div className="checkout">
        <section className="panel">
          {bundle && cart.bundle ? (
            <>
              <div className="plan-service">Paquete · −{bundle.discount_pct}%</div>
              <h2>{bundle.name} en {providerName(cart.bundle.provider)}</h2>
              <p className="muted small">{bundle.description}</p>
              <ul className="line-list">
                {bundle.components.map((c) => {
                  const it = bundleItem(cart.bundle!.provider, c);
                  return <li key={c.category}>{it ? `${it.service} · ${it.plan}` : `${c.category} ${c.plan}`}</li>;
                })}
              </ul>
              <label className="field">Proveedor
                <select value={cart.bundle.provider} disabled={locked} onChange={(e) => {
                  const p = e.target.value as "aws" | "azure" | "huawei";
                  cartStore.updateBundle({ provider: p, region: bundleRegions(bundle, p)[0] ?? "" });
                }}>
                  {(["aws", "azure", "huawei"] as const).map((p) => <option key={p} value={p}>{providerName(p)}</option>)}
                </select>
              </label>
              <label className="field">Región
                <select value={cart.bundle.region} disabled={locked} onChange={(e) => cartStore.updateBundle({ region: e.target.value })}>
                  {bundleRegions(bundle, cart.bundle.provider).map((r) => <option key={r} value={r}>{regionName(cart.bundle!.provider, r)} ({r})</option>)}
                </select>
              </label>
              <label className="field">Plazo
                <select value={cart.bundle.term} disabled={locked} onChange={(e) => cartStore.updateBundle({ term: e.target.value as "monthly" | "annual" })}>
                  <option value="monthly">{TERM_LABEL.monthly}</option>
                  <option value="annual">{TERM_LABEL.annual}</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <h2>Servicios</h2>
              {cart.lines.map((l, i) => {
                const it = findItem(l.item_id);
                if (!it) return null;
                const terms = termsFor(it).filter((t) => t !== "metered" || method === "credits" || l.term === "metered");
                return (
                  <div key={`${l.item_id}-${i}`} className="cart-line">
                    <div className="cart-line-head">
                      <div>
                        <div className="plan-service">{providerName(it.provider)} · {it.service}</div>
                        <strong>{it.plan}</strong>
                      </div>
                      <button className="btn btn-ghost btn-sm" disabled={locked} onClick={() => cartStore.removeLine(i)}>Quitar</button>
                    </div>
                    <div className="cart-line-fields">
                      {it.provider !== "ccm" && (
                        <select value={l.region} disabled={locked} onChange={(e) => cartStore.updateLine(i, { region: e.target.value })}>
                          {it.regions.map((r) => <option key={r} value={r}>{regionName(it.provider, r)}</option>)}
                        </select>
                      )}
                      {terms.length > 1 && (
                        <select value={l.term} disabled={locked} onChange={(e) => { const t = e.target.value as Term; cartStore.updateLine(i, { term: t, qty: defaultQty(it, t) }); }}>
                          {terms.map((t) => <option key={t} value={t}>{TERM_LABEL[t]}</option>)}
                        </select>
                      )}
                      {l.term === "hourly" && (
                        <label className="inline">
                          <input type="number" min={1} max={744} value={l.qty} disabled={locked}
                            onChange={(e) => cartStore.updateLine(i, { qty: Math.max(1, Math.min(744, Number(e.target.value) || 1)) })} /> horas
                        </label>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="muted small"><Link to="/">+ Agregar más servicios</Link></p>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Resumen</h2>
          {previewError && <p className="error small">{previewError}</p>}
          {preview && (
            <dl className="quote">
              {preview.lines.map((l, i) => (
                <div key={i}><dt>{l.service} {l.plan}{l.term === "hourly" ? ` · ${l.qty} h` : l.term === "annual" ? " · 12 meses" : l.term === "metered" ? " · por uso" : ""}</dt><dd>{l.term === "metered" ? "por hora" : usd(l.list_usd)}</dd></div>
              ))}
              {preview.lines.some((l) => Number(l.annual_discount_usd) > 0) && (
                <div><dt>Descuento anual −10% (incluido)</dt><dd>−{usd(preview.lines.reduce((s, l) => s + Number(l.annual_discount_usd), 0))}</dd></div>
              )}
              {preview.bundle && <div><dt>Descuento paquete −{preview.bundle.discount_pct}%</dt><dd>−{usd(preview.bundle.discount_usd)}</dd></div>}
              <div><dt>Total (precio de lista)</dt><dd>{usd(preview.list_total_usd)}</dd></div>
              {IS_SCALED && <div><dt>Total en testnet (×{PRICE_SCALE})</dt><dd className="amount">{usd(preview.total_usd)}</dd></div>}
            </dl>
          )}

          <div className="field">Medio de pago
            <div className="segmented">
              <button className={method === "chain" ? "active" : ""} disabled={locked || hasMetered} onClick={() => setMethod("chain")}>Wallet (escrow)</button>
              <button className={method === "credits" ? "active" : ""} disabled={locked || hasCreditPack} onClick={() => setMethod("credits")}>
                Créditos{credits !== null ? ` (${usd(credits)})` : ""}
              </button>
            </div>
            {hasMetered && <span className="muted small">El pago por uso solo está disponible con créditos.</span>}
            {hasCreditPack && <span className="muted small">Los paquetes de créditos se pagan desde la wallet.</span>}
          </div>

          {method === "credits" && orderRef === null && (
            <>
              {!isConnected && <p className="muted">Conecta tu wallet: firmarás un mensaje (sin gas) para autorizar el cargo.</p>}
              {isConnected && creditsShort && <p className="error small">Saldo de créditos insuficiente. Compra un paquete de créditos en la home.</p>}
              {isConnected && (
                <button className="btn btn-block" onClick={payCredits} disabled={busy || !preview || creditsShort}>
                  {busy ? "Procesando…" : `Pagar ${preview ? usd(preview.total_usd) : ""} con créditos${hasMetered ? " + uso" : ""}`}
                </button>
              )}
            </>
          )}

          {method === "chain" && orderRef === null && (
            <>
              <div className="field">Moneda
                <div className="segmented">
                  {ASSETS.map((a) => <button key={a} className={asset === a ? "active" : ""} onClick={() => setAsset(a)} disabled={busy}>{a}</button>)}
                </div>
              </div>
              <div className="field">Red <span className="pill">{CHAIN.chainId === 56 ? "BNB Smart Chain" : "BNB Smart Chain Testnet"} · {CHAIN.chainId}</span></div>
              {!quote && <button className="btn btn-block" onClick={requestQuote} disabled={busy || !preview}>{busy ? "Pidiendo cotización…" : "Pedir cotización al agente"}</button>}
              {quote && (
                <>
                  <dl className="quote">
                    <div><dt>Monto firmado</dt><dd className="amount">{formatUnits(BigInt(quote.amount_atomic), quote.asset.decimals)} {quote.asset.symbol}</dd></div>
                    <div><dt>Vendedor (agente)</dt><dd><a href={addressUrl(quote.provider)} target="_blank" rel="noreferrer">{short(quote.provider)}</a></dd></div>
                    <div><dt>Escrow (Commerce)</dt><dd><a href={addressUrl(quote.commerce)} target="_blank" rel="noreferrer">{short(quote.commerce)}</a></dd></div>
                    <div><dt>Cotización</dt><dd>{expired ? <span className="error">expirada</span> : `válida ${Math.max(0, quote.quote_expires_at - now)} s`}</dd></div>
                  </dl>
                  {!isConnected && <p className="muted">Conecta tu wallet para pagar.</p>}
                  {isConnected && chainId !== CHAIN.chainId && <button className="btn btn-warn btn-block" onClick={() => switchChain({ chainId: APP_CHAIN_ID })}>Cambiar de red</button>}
                  {insufficient && (
                    <p className="error small">
                      Saldo insuficiente: tienes {formatUnits(balance!, quote.asset.decimals)} {quote.asset.symbol}.
                      {CHAIN.chainId === 97 && (quote.asset.symbol === "U" ? " Pide U de prueba al bot de Telegram @bnbchain_official_bot." : " El bot de Telegram solo entrega U: elige U como moneda.")}
                    </p>
                  )}
                  {expired && <button className="btn btn-block" onClick={requestQuote} disabled={busy}>Renovar cotización</button>}
                  {!expired && isConnected && chainId === CHAIN.chainId && (
                    <button className="btn btn-block" onClick={payChain} disabled={busy || insufficient}>
                      {busy ? "Procesando…" : `Pagar ${formatUnits(BigInt(quote.amount_atomic), quote.asset.decimals)} ${quote.asset.symbol}`}
                    </button>
                  )}
                  <p className="muted small">Un solo pago en escrow cubre todo el carrito: 4–5 transacciones en tu wallet.</p>
                </>
              )}
            </>
          )}

          {Object.keys(steps).length > 0 && (
            <ol className="steps">
              {stepOrder.map((s) => {
                const st = steps[s];
                return (
                  <li key={s} className={`step ${st?.state ?? "todo"}`}>
                    <span>{STEP_LABELS[s]}</span>
                    <span className="step-state">
                      {st?.state === "wallet" && "confirma en tu wallet…"}
                      {st?.state === "mining" && "esperando confirmación…"}
                      {st?.state === "done" && "✓"}
                      {st?.state === "skipped" && "no necesario"}
                      {st?.hash && <> · <a href={txUrl(st.hash)} target="_blank" rel="noreferrer">{short(st.hash)}</a></>}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {orderRef !== null && (
            <div className="result">
              <div>Pedido <strong>{orderRef.startsWith("cr-") ? orderRef.slice(0, 11) + "…" : `#${orderRef}`}</strong> {status && <StatusBadge status={status} />}</div>
              {status === "pagado" && <p className="muted small">Pago confirmado. El agente está aprovisionando…</p>}
              {status === "provisionado" && <button className="btn btn-block" onClick={() => navigate("/pedidos")}>Ver credenciales en Mis pedidos</button>}
              {status === "fallido" && <p className="error small">El aprovisionamiento falló. Reembolso: escrow con claimRefund al expirar, o créditos devueltos automáticamente.</p>}
            </div>
          )}
          {error && <p className="error">{error}</p>}
        </section>
      </div>
    </>
  );
}
