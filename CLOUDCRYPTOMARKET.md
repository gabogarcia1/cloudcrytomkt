# CloudCryptoMarket

Marketplace de servicios cloud (AWS, Azure, Huawei Cloud) pagados en stablecoins
(U, USDC, USDT) en BNB Chain. Un agente vendedor ERC-8183 cotiza, verifica el pago
en escrow y aprovisiona; una web React permite comprar desde la wallet del cliente.

```
cloudcryptomkt/
├── app/agent/                  agente vendedor (bag init, único firmante)
│   ├── catalog.json            ← ÚNICA fuente del catálogo (la web la importa)
│   ├── studio.toml             red, activos aceptados, rails, storage
│   ├── src/
│   │   ├── catalog.ts          validación, precio exacto, línea de pedido on-chain
│   │   ├── pricing.ts          USD → unidades atómicas por token (solo lectura)
│   │   ├── signing.ts          TODA la firma: signItemQuote / submitResult / settle
│   │   ├── sellerCore.ts       negotiate + notify_funded (A2A)
│   │   ├── mcpMain.ts          mismas operaciones por MCP + tools de solo lectura
│   │   ├── dualMain.ts         servidor A2A + /mcp + /x402 + API REST /api
│   │   ├── orders.ts           entrega: verificar → provision → recibo → submit
│   │   ├── marketTools.ts      list_catalog / get_quote / order_status
│   │   ├── tools.ts            tools del LLM (solo lectura)
│   │   └── fulfillment/        provision(order) + adaptadores aws/azure/huawei
│   └── scripts/                smoke.mjs, test-fulfillment.ts, export-chain-config.mjs
└── web/                        storefront React + Vite + wagmi/viem
```

## 1. Cómo se fija y firma el precio (sin LLM)

1. El comprador (web, otro agente por A2A o un cliente MCP) envía
   `negotiate { item_id, region, asset }`.
2. `catalog.ts › validateSelection` comprueba que el ítem existe y que la región
   está en `regions`. Si no, se devuelve un rechazo **sin firma**.
3. `itemTotalUsd` = `price_usd_month × contract_months` con aritmética entera
   (`bigint`, 6 decimales). No hay floats.
4. `pricing.ts › resolveSellerAsset` mapea `USDT`/`TEST_USDT`/dirección a uno de
   los activos de `[payments.seller].assets`. Cualquier otro activo se rechaza.
5. `signing.ts › signItemQuote` construye la petición canónica:
   `task_description = "CloudCryptoMarket order v1 | item=<id> | region=<r> | months=<n>"`
   y llama al `NegotiationHandler` multi-activo del SDK con el precio del ítem.
   El SDK convierte el USD a las unidades atómicas exactas del token (con sus
   decimales del catálogo de red) y firma con **EIP-191** el `negotiation_hash`,
   que liga: tarea (el ítem), términos, precio, token, `chain_id`, contrato
   Commerce y expiración (TTL 900 s). La cotización no se puede reutilizar en otra
   red, token, contrato o ítem.
6. La respuesta incluye `ccm.job_description` (lo que el comprador ancla en
   `createJobWithToken`) y `ccm.amount_atomic` (lo que fondea).

El LLM no participa en ningún paso de dinero: ni en el precio, ni en la firma, ni
en la entrega. Solo actúa como asistente de soporte en la cara x402 y tiene
herramientas de solo lectura.

## 2. Venta de extremo a extremo

```
web/agente ──negotiate──► agente: catálogo → precio → signItemQuote (EIP-191)
comprador ── createJobWithToken → registerJob → setBudget → approve → fund   (su wallet)
web/agente ──notify_funded(job_id)──► agente:
      verifySignedJob (firma propia + presupuesto + plazo, on-chain)
      → deliverOrder: item desde la descripción on-chain firmada
      → fulfillment.provision(order)      (idempotente)
      → recibo JSON (sin secretos, con sha256 de las credenciales)
      → signing.submitResult  → job SUBMITTED
comprador ──firma un mensaje──► GET credenciales (solo la wallet que pagó)
```

## 3. Idempotencia: un job pagado nunca aprovisiona dos veces

| Capa | Mecanismo |
| --- | --- |
| Proceso | `fulfillment/index.ts`: un `Map<orderId, Promise>` hace que un notify A2A, el sweep y un notify MCP concurrentes compartan una sola llamada. |
| Persistente | `fulfillment/store.ts`: libro de pedidos (`.data/orders.json`). Si ya hay `result`, se devuelve sin tocar la nube; el reintento solo vuelve a hacer el `submit`. |
| Nube | `order.idempotencyKey = ccm-<chainId>-<jobId>`: los adaptadores derivan de él los nombres y client tokens (EC2 `ClientToken`, nombres ARM de Azure, `X-Client-Token` de Huawei). Si el proceso cae entre "creado en la nube" y "registrado", el reintento converge en el mismo recurso. |
| Cadena | `verifySignedJob` rechaza un job ya `SUBMITTED`. El `submit` no puede repetirse. |

`scripts/test-fulfillment.ts` verifica las tres primeras capas.

## 4. Reembolso y disputa

**Si el aprovisionamiento falla:**

- **Fallo permanente** (`ProvisionError(retryable=false)`: sin cuota, región no
  disponible, API sin conectar). El agente **no** hace `submit` ni inventa un
  entregable. El pedido queda `fallido` en el libro y el job sigue `FUNDED`.
  Cuando pasa `expiredAt`, el comprador llama a `claimRefund(jobId)` (botón
  "Reclamar reembolso" en *Mis pedidos*) y el escrow vuelve íntegro a su wallet.
  El vendedor no puede retener esos fondos.
- **Fallo transitorio** (timeout, API caída). El job sigue `FUNDED` y se
  reintenta en el siguiente `notify_funded` o sweep, con la misma clave de
  idempotencia, mientras quede ventana de entrega (`expiredAt − disputeWindow`).
  Si la ventana se agota, se aplica el mismo reembolso.

**Si se entregó pero el cliente no está conforme:** tras el `submit` corre la
ventana de disputa (900 s en testnet, 24 h en mainnet). El comprador puede abrir
`dispute(jobId)`. Para defenderse, el vendedor cuenta con:

- la descripción on-chain firmada por ambas partes (ítem, región, specs como
  `success_criteria`);
- el recibo publicado (endpoint, `resource_id`, vencimiento, `sha256` de las
  credenciales entregadas, que prueba qué se entregó sin revelarlo);
- el rastro de auditoría de la nube (CloudTrail / Azure Activity Log / Huawei CTS)
  de la creación del recurso.

Si nadie disputa, el silencio aprueba y el operador cobra con
`bag erc8183 settle <job_id>` (manual, requiere tu aprobación). ERC-8183 es todo o
nada: para devoluciones parciales posteriores (cancelación a mitad de mes) haz
una transferencia aparte, fuera del escrow.

## 5. Ejecutar en local

```powershell
cd cloudcryptomkt
bag dev --port 9100                  # :9000 está ocupado por kiosco
# en otra terminal
cd web; pnpm dev                     # http://localhost:5173
cd app/agent; node scripts/smoke.mjs http://127.0.0.1:9100
cd app/agent; pnpm exec tsx scripts/test-fulfillment.ts
```

Storage: para desarrollo local está en `local`. Para volver a IPFS:
`bag config set storage.kind ipfs`, `bag env set STORAGE_API_URL <endpoint>` y
`bag env set STORAGE_API_KEY <clave>`.

### Compra E2E en testnet (con tu MetaMask)

1. Añade BNB Smart Chain Testnet (chainId 97) a MetaMask.
2. Pide tBNB (gas) y U de prueba al bot https://t.me/bnbchain_official_bot. Si
   quieres pagar con USDT o USDC, consigue los tokens de prueba
   `0x3376…4dDd` (USDT) o `0x6454…8930` (USDC).
3. Abre http://localhost:5173 → proveedor → plan → **Pedir cotización** →
   **Pagar**. Firmarás 4 o 5 transacciones.
4. Espera el estado *Provisionado* y, en **Mis pedidos**, pulsa
   **Ver credenciales** (firma un mensaje, sin gas).

## 5b. Ampliación v2: catálogo, cobro, asesor, paquetes y servicios

**Catálogo:** 93 ítems. Cada proveedor tiene 9 categorías: storage, cómputo,
agentes de IA, bases de datos, CDN y DNS, backups y DR, GPU, Kubernetes y
seguridad. Además hay créditos y consultoría bajo el proveedor `ccm`, y 3
`bundles`.

**Modelos de cobro** (`catalog.ts › priceCart`, todo en micro-USD entero):

| Plazo | Fórmula | Pago |
| --- | --- | --- |
| `monthly` | `price_usd_month × contract_months` | escrow o créditos |
| `annual` | `price_usd_month × 12 × 0.90` | escrow o créditos |
| `hourly` | `price_usd_hour × horas` (1–744, prepago) | escrow o créditos |
| `metered` | `price_usd_hour` por hora de uso, descontado por `meter.ts` | **solo créditos** |
| `once` | `price_usd` (paquetes de créditos, consultoría) | escrow (créditos: no) |

Los paquetes aplican −15% sobre la suma de sus líneas. Después se aplica
`price_scale` de la red (×0.001 en testnet). Cada descuento redondea hacia abajo
a 1 micro-USD. Un carrito admite hasta 8 líneas y se paga con **un solo escrow**.
La línea on-chain v2 es
`CloudCryptoMarket order v2 | bundle=<id|-> | lines=<item>@<región>~<plazo>~<cantidad>;…`
y las líneas v1 siguen siendo válidas.

**Todo o nada:** si una línea falla de forma permanente, las ya aprovisionadas
se deshacen (`deprovision`, estado `rolled_back`). El escrow se recupera con
`claimRefund`; en un pedido con créditos se devuelve el saldo.

**Créditos prepagos** (`credits.ts`): libro por wallet, idempotente por `ref`.
- **Recargas:** paquetes de 5, 20 y 100 USD (bonus de 0%, 5% y 10%) pagados por
  escrow, o recargas x402 enviando `{"action":"credits_topup"}` a `/x402`, que
  abonan el precio x402 a la wallet que paga.
- **Gasto:** el comprador firma (EIP-191, sin gas) el mensaje que devuelve
  `POST /api/credits/quote` y lo envía a `POST /api/credits/purchase`.
- **Medición de uso:** `meter.ts` cobra cada hora iniciada y detiene el recurso
  cuando falta saldo. Para la demo, `CCM_METER_SECONDS_PER_HOUR=60` hace que
  1 minuto equivalga a 1 hora.

**Consultoría:** cada paquete de horas abre una tarea `pendiente`. El operador la
avanza con:
```powershell
cd app/agent
pnpm exec tsx scripts/task.ts list
pnpm exec tsx scripts/task.ts set <taskId> en_curso "Kickoff agendado"
pnpm exec tsx scripts/task.ts set <taskId> entregada "Informe enviado"
```

**Asesor `recommend_provider`** (solo lectura; A2A, MCP y `POST /api/recommend`):
1. Los requisitos se extraen con un parser de reglas (es/en). Con
   `CCM_ADVISOR_LLM_EXTRACT=1` también usa el LLM.
2. En cada proveedor se elige de forma determinista el ítem más barato que
   cumple cada requisito, y se suma el total mensual.
3. Se recomienda el más barato (decisión determinista). El LLM solo redacta la
   justificación, entre etiquetas `<respuesta>`, porque `auto/free` puede
   enrutar a un modelo que muestra su razonamiento.
4. Se devuelve un `cart` listo para `negotiate`. La web pinta primero la
   comparativa (instantánea) y después el texto del LLM (unos 10 s).

## 6. Pendiente para mainnet

1. Red: `bag config set network.default bsc-mainnet` y activos `U, USDC, USDT` en
   `[payments.seller].assets`. En la web: `pnpm chain:export bsc-mainnet` y
   `VITE_NETWORK=bsc-mainnet`.
2. Gas propio: en mainnet no hay paymaster para ERC-8183. La wallet del agente
   necesita BNB.
3. Libros durables para pedidos, créditos y tareas (DynamoDB con escrituras
   condicionales): el disco de AgentCore es efímero y puede haber varias
   instancias. El medidor (`meter.ts`) debe correr en un solo lugar, por ejemplo
   EventBridge + Lambda, y no en cada instancia.
4. Credenciales en reposo: hoy `.data/orders.json` las guarda en claro (local).
   Muévelas a Secrets Manager / KMS y bórralas tras la entrega.
5. Adaptadores reales (`FULFILLMENT_MODE=live`): conectar los puntos
   `REAL API: connect here`, con credenciales del operador inyectadas por el
   canal de secretos del deploy y permisos mínimos. Falta también el
   **des-aprovisionamiento** al vencer el contrato y la renovación.
6. Storage `ipfs` o `s3` para los recibos.
7. Auth: AgentCore exige OAuth (Cognito) en A2A/MCP. La web no puede guardar el
   client secret: hace falta un pequeño backend o proxy (BFF) que lo use, o
   publicar `/api` por otra ruta.
8. x402: credenciales de merchant B402 o desactivarlo
   (`payments.b402_seller.enabled=false`), más un `replayStore` durable (aviso M01).
9. Identidad ERC-8004 con `bag deploy verify` tras el deploy.
10. Negocio: acuerdos de reventa (AWS Partner, Azure CSP, Huawei Partner),
    términos de servicio y cumplimiento para pagos en cripto.
