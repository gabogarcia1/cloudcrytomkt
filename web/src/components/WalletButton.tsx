import { useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN } from "../config";
import { APP_CHAIN_ID } from "../wagmi";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);

  if (isConnected && address) {
    const wrongChain = chainId !== CHAIN.chainId;
    return (
      <div className="wallet">
        {wrongChain ? (
          <button className="btn btn-warn" onClick={() => switchChain({ chainId: APP_CHAIN_ID })}>
            Cambiar a {CHAIN.chainId === 56 ? "BNB Chain" : "BNB Testnet"}
          </button>
        ) : (
          <span className="pill">{short(address)}</span>
        )}
        <button className="btn btn-ghost" onClick={() => disconnect()}>Salir</button>
      </div>
    );
  }

  return (
    <div className="wallet">
      <button className="btn" onClick={() => setOpen((v) => !v)} disabled={isPending}>
        {isPending ? "Conectando…" : "Conectar wallet"}
      </button>
      {open && (
        <div className="menu">
          {connectors.map((c) => (
            <button key={c.uid} className="menu-item" onClick={() => { connect({ connector: c, chainId: APP_CHAIN_ID }); setOpen(false); }}>
              {c.name === "Injected" ? "MetaMask / wallet del navegador" : c.name}
            </button>
          ))}
          {error && <div className="error small">{error.message}</div>}
        </div>
      )}
    </div>
  );
}
