import { http, createConfig } from "wagmi";
import { bsc, bscTestnet } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { CHAIN, WC_PROJECT_ID } from "./config";

const chain = CHAIN.chainId === bsc.id ? bsc : bscTestnet;
export const APP_CHAIN_ID = chain.id;

// MetaMask / Trust / Binance Web3 via the injected provider; WalletConnect when
// a project id is configured. The storefront never handles private keys.
export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [walletConnect({ projectId: WC_PROJECT_ID, metadata: { name: "CloudCryptoMarket", description: "Cloud services paid in stablecoins", url: window.location.origin, icons: [] } })]
      : []),
  ],
  transports: { [chain.id]: http(CHAIN.rpcUrl ?? undefined) } as Record<typeof chain.id, ReturnType<typeof http>>,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
