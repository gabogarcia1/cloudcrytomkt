import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatUnits } from "viem";
import { useAccount, useConfig, useSignMessage } from "wagmi";
import {
  type OrderStatus,
  buyerOrders,
  creditsBalance,
  credentialsMessage,
  fetchCredentials,
  notifyFunded,
  orderStatus,
} from "../agent";
import { TERM_LABEL, type Term, findItem, providerName, regionName, usd } from "../catalog";
import { claimRefund } from "../checkout";
import { StatusBadge } from "../components/StatusBadge";
import { short } from "../components/WalletButton";
import { txUrl } from "../config";
import { type LocalOrder, localOrdersFor } from "../localOrders";

interface Row {
  ref: string;
  local: LocalOrder | null;
  status: OrderStatus | null;
  error: string | null;
}

const TASK_LABEL: Record<string, string> = { pendiente: "Pendiente", en_curso: "En curso", entregada: "Entregada", cancelada: "Cancelada" };

export function Orders() {
  const { address, isConnected } = useAccount();
  const [rows, setRows] = useState<Row[]>([]);
  const [credits, setCredits] = useState<{ balance_usd: string; entries: Array<{ ts: string; amount_usd: string; reason: string }> } | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    const local = localOrdersFor(address);
    let remote: string[] = [];
    try { remote = (await buyerOrders(address)).orders.map((o) => String(o.id)); } catch { /* agent offline */ }
    creditsBalance(address).then(setCredits).catch(() => setCredits(null));
    const refs = [...new Set([...local.map((o) => o.jobId), ...remote])];
    const next = await Promise.all(refs.map(async (ref): Promise<Row> => {
      const l = local.find((o) => o.jobId === ref) ?? null;
      try { return { ref, local: l, status: await orderStatus(ref), error: null }; }
      catch (e) { return { ref, local: l, status: null, error: e instanceof Error ? e.message : String(e) }; }
    }));
    next.sort((a, b) => (b.local?.createdAt ?? "").localeCompare(a.local?.createdAt ?? "") || Number(b.ref) - Number(a.ref));
    setRows(next);
    setLoading(false);
  }, [address]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const live = rows.some((r) => r.status?.status === "pagado" || r.status?.lines.some((l) => l.term === "metered" && l.state !== "stopped"));
    if (!live) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [rows, load]);

  if (!isConnected) return <div className="panel"><h1>Mis pedidos</h1><p>Conecta tu wallet para ver tus pedidos.</p></div>;

  return (
    <>
      <div className="page-head">
        <h1>Mis pedidos</h1>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={loading}>{loading ? "Actualizando…" : "Actualizar"}</button>
      </div>
      {credits && (
        <details className="panel credits-panel">
          <summary>Créditos prepagos: <strong>{usd(credits.balance_usd)}</strong></summary>
          {credits.entries.length === 0 ? <p className="muted small">Sin movimientos.</p> : (
            <dl className="specs">
              {credits.entries.slice(0, 15).map((e, i) => <div key={i}><dt>{new Date(e.ts).toLocaleString("es")} · {e.reason}</dt><dd>{e.amount_usd}</dd></div>)}
            </dl>
          )}
        </details>
      )}
      {rows.length === 0 && !loading && <p className="muted">Aún no tienes pedidos. <Link to="/">Explora el catálogo</Link>.</p>}
      <div className="orders">
        {rows.map((r) => <OrderCard key={r.ref} row={r} onChange={load} />)}
      </div>
    </>
  );
}

function OrderCard({ row, onChange }: { row: Row; onChange: () => Promise<void> }) {
  const config = useConfig();
  const { signMessageAsync } = useSignMessage();
  const [creds, setCreds] = useState<Array<{ line: number; item_id: string; credentials: Record<string, string> }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const s = row.status;
  const isCredits = row.ref.startsWith("cr-");
  const now = Math.floor(Date.now() / 1000);
  const canRefund = s !== null && s.chain_status === "FUNDED" && (s.expired_at ?? 0) > 0 && (s.expired_at ?? 0) < now;
  const fundTx = row.local?.txs.fund;
  const lines = s?.lines.length ? s.lines : (s?.planned_lines ?? []).map((l, i) => ({ order_id: `${row.ref}#${i}`, line: i, item_id: l.itemId, region: l.region, term: l.term, qty: l.qty, state: "pendiente", error: null, resource: null, task: null, metered_hours_billed: null }));
  const hasSecrets = lines.some((l) => l.resource && !["ccm"].includes(findItem(l.item_id)?.provider ?? ""));

  async function showCredentials() {
    setBusy(true); setMsg(null);
    try {
      const { message, issued_at } = await credentialsMessage(row.ref);
      const signature = await signMessageAsync({ message });
      setCreds((await fetchCredentials(row.ref, signature, issued_at)).lines);
    } catch (e) { setMsg(e instanceof Error ? e.message.split("\n")[0] ?? "error" : String(e)); }
    finally { setBusy(false); }
  }

  async function nudge() {
    setBusy(true); setMsg(null);
    try { const ack = await notifyFunded(BigInt(row.ref)); setMsg(`Agente: ${String(ack.status)}${ack.reason ? ` — ${String(ack.reason)}` : ""}`); await onChange(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function refund() {
    setBusy(true); setMsg(null);
    try { const hash = await claimRefund(config, BigInt(row.ref)); setMsg(`Reembolso enviado: ${hash}`); await onChange(); }
    catch (e) { setMsg(e instanceof Error ? e.message.split("\n")[0] ?? "error" : String(e)); }
    finally { setBusy(false); }
  }

  const title = row.local?.summary ?? lines.map((l) => { const it = findItem(l.item_id); return it ? `${it.service} ${it.plan}` : l.item_id; }).join(" + ");

  return (
    <article className="order-card">
      <header className="order-head">
        <div>
          <div className="plan-service">{isCredits ? `Pedido con créditos ${row.ref.slice(0, 11)}…` : `Pedido #${row.ref}`}{s?.bundle_id ? ` · paquete ${s.bundle_id}` : ""}</div>
          <h3>{title || "—"}</h3>
        </div>
        {s ? <StatusBadge status={s.status} /> : <span className="badge">sin datos</span>}
      </header>
      <dl className="specs">
        {row.local && !isCredits && <div><dt>Monto</dt><dd>{formatUnits(BigInt(row.local.amountAtomic), row.local.decimals)} {row.local.symbol}</dd></div>}
        {isCredits && s?.total_usd && <div><dt>Cargo en créditos</dt><dd>{usd(s.total_usd)}</dd></div>}
        {s?.chain_status && <div><dt>Estado on-chain</dt><dd>{s.chain_status}</dd></div>}
        {fundTx && <div><dt>Tx de pago</dt><dd><a href={txUrl(fundTx)} target="_blank" rel="noreferrer">{short(fundTx)}</a></dd></div>}
        {s?.submit_tx && <div><dt>Tx de entrega</dt><dd><a href={txUrl(s.submit_tx)} target="_blank" rel="noreferrer">{short(s.submit_tx)}</a></dd></div>}
      </dl>
      <div className="order-lines">
        {lines.map((l) => {
          const it = findItem(l.item_id);
          return (
            <div key={l.order_id} className="order-line">
              <div className="order-line-head">
                <strong>{it ? `${providerName(it.provider)} · ${it.service} ${it.plan}` : l.item_id}</strong>
                <span className="pill">{l.state}</span>
              </div>
              <div className="muted small">
                {it?.provider !== "ccm" && `${regionName(it?.provider ?? "", l.region)} · `}{TERM_LABEL[l.term as Term] ?? l.term}{l.term === "hourly" ? ` · ${l.qty} h` : ""}
                {l.metered_hours_billed != null && ` · ${l.metered_hours_billed} h facturadas`}
              </div>
              {l.resource && it?.category !== "consulting" && it?.category !== "credits" && (
                <div className="small"><span className="mono">{l.resource.endpoint}</span>{l.resource.mock ? " · simulado" : ""} · vence {new Date(l.resource.expiresAt).toLocaleDateString("es")}</div>
              )}
              {it?.category === "credits" && l.resource && <div className="small">Saldo acreditado: {String(l.resource.details.credited_usd ?? "")}</div>}
              {l.task && (
                <div className="small">Tarea {l.task.task_id.slice(-10)}: <span className={`badge badge-task-${l.task.state}`}>{TASK_LABEL[l.task.state] ?? l.task.state}</span>
                  {l.task.notes.length > 0 && <div className="muted">{l.task.notes.at(-1)}</div>}
                </div>
              )}
              {l.error && <div className="error small">{l.error}</div>}
            </div>
          );
        })}
      </div>
      <div className="order-actions">
        {s?.status === "provisionado" && hasSecrets && !creds && <button className="btn" onClick={showCredentials} disabled={busy}>Ver credenciales (firmar)</button>}
        {s?.status === "pagado" && !isCredits && <button className="btn btn-ghost" onClick={nudge} disabled={busy}>Avisar al agente</button>}
        {canRefund && <button className="btn btn-warn" onClick={refund} disabled={busy}>Reclamar reembolso</button>}
        {s?.status === "pendiente" && <span className="muted small">Pago sin completar (job sin fondos).</span>}
      </div>
      {creds && (
        <div className="creds">
          <div className="creds-head">Credenciales <span className="muted small">— guárdalas en un lugar seguro</span></div>
          {creds.filter((c) => Object.keys(c.credentials).length > 0).map((c) => (
            <div key={c.line}>
              <div className="small"><strong>{findItem(c.item_id)?.service} {findItem(c.item_id)?.plan}</strong></div>
              {Object.entries(c.credentials).map(([k, v]) => (
                <div key={k} className="cred"><span className="mono key">{k}</span><pre className="mono">{v}</pre></div>
              ))}
            </div>
          ))}
        </div>
      )}
      {msg && <p className="small muted">{msg}</p>}
    </article>
  );
}
