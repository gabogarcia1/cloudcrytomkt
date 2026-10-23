import { formatUnits } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { CHAIN } from "../config";
import { APP_CHAIN_ID } from "../wagmi";

const U = CHAIN.assets.find((a) => a.symbol === "U");

function fmt(value: bigint | undefined, decimals: number): string {
  if (value === undefined) return "…";
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && n < 1 ? 5 : 3 });
}

/** Native gas balance + U payment-token balance of the connected wallet. */
export function WalletBalances() {
  const { address } = useAccount();
  const native = useBalance({ address, chainId: APP_CHAIN_ID, query: { enabled: !!address, refetchInterval: 10_000 } });
  const u = useReadContract({
    address: U?.address,
    abi: CHAIN.erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: APP_CHAIN_ID,
    query: { enabled: !!address && !!U, refetchInterval: 10_000 },
  });

  if (!address) return null;
  const gasSymbol = CHAIN.chainId === 56 ? "BNB" : "tBNB";
  return (
    <div className="balances" title="Saldo disponible en tu wallet (se actualiza cada 10 s)">
      <span className="balance"><b>{fmt(native.data?.value, 18)}</b> {gasSymbol}</span>
      {U && <span className="balance"><b>{fmt(u.data as bigint | undefined, U.decimals)}</b> U</span>}
    </div>
  );
}
