// Export the ERC-8183 contract ABIs + addresses and the payment-asset catalog
// for one network into web/src/chain/<network>.json, so the browser checkout
// talks to exactly the contracts the agent's SDK uses. Read-only: no wallet.
//
//   node scripts/export-chain-config.mjs [bsc-testnet|bsc-mainnet]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ERC8183Client } from "@bnbagent/sdk/erc8183";
import { listAssets } from "@bnbagent/sdk/networks";

const network = process.argv[2] ?? "bsc-testnet";
const client = await ERC8183Client.create({ network });
const chainId = client.network.chainId;

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
];

const out = {
  network,
  chainId,
  rpcUrl: client.network.rpcUrl ?? null,
  commerce: { address: client.commerce.address, abi: client.commerce.abi },
  router: { address: client.router.address, abi: client.router.abi },
  policy: { address: client.policy.address },
  disputeWindowSeconds: Number(await client.policy.disputeWindow()),
  erc20Abi,
  assets: listAssets(chainId).map((a) => ({
    assetId: a.assetId,
    symbol: a.symbol,
    address: a.address,
    decimals: a.decimals,
  })),
};

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../../web/src/chain", `${network}.json`);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
console.log(`wrote ${target} (chainId ${chainId}, ${out.assets.length} assets)`);
