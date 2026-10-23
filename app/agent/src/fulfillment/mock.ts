/** Helpers shared by the mock adapters: deterministic sample values. */

import { createHash } from "node:crypto";
import type { Order } from "./types.js";

/** Deterministic hex derived from the idempotency key (same key → same value). */
export function stableHex(order: Order, label: string, len = 12): string {
  return createHash("sha256")
    .update(`${order.idempotencyKey}:${label}`)
    .digest("hex")
    .slice(0, len);
}

/** Deterministic sample secret — clearly marked so nobody mistakes it for real. */
export function sampleSecret(order: Order, label: string): string {
  return `MOCK-${createHash("sha256")
    .update(`${order.idempotencyKey}:secret:${label}`)
    .digest("base64url")
    .slice(0, 32)}`;
}

/** End of the contracted period, counted from now (by billing term). */
export function contractEnd(order: Order): string {
  const d = new Date();
  switch (order.term) {
    case "annual":
      d.setUTCMonth(d.getUTCMonth() + 12);
      break;
    case "hourly":
      d.setTime(d.getTime() + order.qty * 3600_000);
      break;
    case "metered":
      d.setUTCFullYear(d.getUTCFullYear() + 10); // runs while credits last
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + order.item.contract_months);
  }
  return d.toISOString();
}

/** `FULFILLMENT_MODE=live` switches adapters to their real API path. */
export function liveMode(): boolean {
  return process.env.FULFILLMENT_MODE === "live";
}

export function sshCredentials(order: Order, user: string): Record<string, string> {
  return {
    SSH_USER: user,
    SSH_PRIVATE_KEY: `-----BEGIN OPENSSH PRIVATE KEY-----\n${sampleSecret(order, "ssh")}\n-----END OPENSSH PRIVATE KEY-----`,
  };
}

export function dbCredentials(order: Order, user = "ccm_admin"): Record<string, string> {
  return { DB_USER: user, DB_PASSWORD: sampleSecret(order, "db") };
}

export function kubeconfig(order: Order, server: string, cluster: string): Record<string, string> {
  return {
    KUBECONFIG: [
      "apiVersion: v1",
      "kind: Config",
      `clusters: [{ name: ${cluster}, cluster: { server: "${server}" } }]`,
      `users: [{ name: ccm-admin, user: { token: "${sampleSecret(order, "k8s")}" } }]`,
      `contexts: [{ name: ${cluster}, context: { cluster: ${cluster}, user: ccm-admin } }]`,
      `current-context: ${cluster}`,
    ].join("\n"),
  };
}
