import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { type Recommendation, recommend } from "../agent";
import { cartStore } from "../cart";
import { IS_SCALED, PRICE_SCALE, categoryOf, regionName, usd } from "../catalog";

const EXAMPLES = [
  "App web con 2 TB de archivos, 4 vCPU, base de datos y tráfico alto",
  "Entrenar un modelo de IA con GPU, 10 TB de datos y 3 agentes de IA en Latinoamérica",
  "Plataforma de microservicios en Kubernetes con 6 nodos, base de datos grande crítica, WAF y backups de 90 días",
  "Tienda online pequeña en México con base de datos, CDN y protección DDoS",
];

export function Advisor() {
  const navigate = useNavigate();
  const [text, setText] = useState(EXAMPLES[0]!);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setBusy(true); setError(null); setRec(null);
    try {
      // 1) instant deterministic comparison, 2) LLM-written reasoning when ready
      const fast = await recommend(text, false);
      setRec(fast);
      setBusy(false);
      if (fast.recommended) {
        setThinking(true);
        recommend(text, true)
          .then((full) => setRec((cur) => (cur && full.reasoning_source === "llm" ? { ...cur, reasoning: full.reasoning, reasoning_source: "llm" } : cur)))
          .catch(() => undefined)
          .finally(() => setThinking(false));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function buy(provider: string) {
    const o = rec?.options.find((x) => x.provider === provider);
    if (!o) return;
    cartStore.setLines(o.cart, `Asesor de costos (${o.provider_name})`);
    navigate("/carrito");
  }

  const best = rec?.options.find((o) => o.provider === rec.recommended);

  return (
    <>
      <div className="page-head"><h1>Asesor de costos</h1></div>
      <section className="panel">
        <label className="field">Describe tu carga de trabajo
          <textarea rows={3} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="ej.: app web con 2 TB de archivos, 4 vCPU, base de datos y tráfico alto" />
        </label>
        <div className="chips">
          {EXAMPLES.map((ex) => <button key={ex} className="chip" onClick={() => setText(ex)}>{ex.length > 48 ? `${ex.slice(0, 48)}…` : ex}</button>)}
        </div>
        <button className="btn btn-block" onClick={ask} disabled={busy || text.trim().length < 3}>{busy ? "Analizando…" : "Recomendar proveedor"}</button>
        <p className="muted small">Consulta de solo lectura: el asesor no firma ni cobra. El precio vinculante lo firma el agente al cotizar el carrito.</p>
        {error && <p className="error">{error}</p>}
      </section>

      {rec && rec.recommended === null && <p className="panel">{rec.reasoning}</p>}

      {rec && best && (
        <>
          <section className="panel recommendation">
            <div className="plan-service">Recomendación {rec.reasoning_source === "llm" ? "· redactada por IA" : thinking ? "· la IA está redactando el análisis…" : ""}</div>
            <h2>{best.provider_name}: {usd(best.monthly_list_usd)}/mes <span className="muted small">(ahorras {usd(rec.savings_usd_month)}/mes)</span></h2>
            <p>{rec.reasoning}</p>
            <button className="btn" onClick={() => buy(best.provider)}>Comprar este paquete</button>
          </section>

          <div className="advisor-grid">
            {rec.options.map((o) => (
              <article key={o.provider} className={`plan-card ${o.provider === rec.recommended ? "recommended" : ""} provider-${o.provider}`}>
                <div className="plan-service">{o.provider === rec.recommended ? "★ Recomendado" : "Alternativa"}</div>
                <h3 className="plan-name">{o.provider_name}</h3>
                <div className="plan-price">{usd(o.monthly_list_usd)}<span>/mes</span></div>
                {IS_SCALED && <div className="real-price">En testnet pagas {usd(o.total_usd)} (×{PRICE_SCALE})</div>}
                <ul className="line-list">
                  {o.lines.map((l) => (
                    <li key={l.item_id}>
                      <strong>{categoryOf(l.category)?.name}</strong>: {l.service} {l.plan} — {usd(l.list_usd_month)}
                      <div className="cell-sub">{regionName(o.provider, l.region)}{l.meets ? "" : " · ⚠ no cubre todo el requisito"}</div>
                    </li>
                  ))}
                </ul>
                {o.unmet.length > 0 && <p className="error small">No cubre: {o.unmet.join(", ")}</p>}
                <button className="btn btn-block" onClick={() => buy(o.provider)}>Comprar este paquete</button>
              </article>
            ))}
          </div>

          <details className="panel">
            <summary>Requisitos detectados ({rec.extraction ?? "reglas"})</summary>
            <pre className="mono">{JSON.stringify(rec.requirements, null, 2)}</pre>
          </details>
        </>
      )}
    </>
  );
}
