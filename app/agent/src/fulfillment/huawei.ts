/**
 * Huawei Cloud adapter — OBS, ECS, ModelArts / Pangu, GaussDB, CDN + DNS,
 * CBR, ECS GPU, CCE, WAF / Advanced Anti-DDoS / Config + SecMaster.
 *
 * Runs with the OPERATOR's account: HUAWEICLOUD_SDK_AK / HUAWEICLOUD_SDK_SK
 * and HUAWEICLOUD_PROJECT_ID (per region). Buyer credentials are never
 * accepted. Each buyer gets an IAM sub-user scoped to their resource.
 */

import {
  contractEnd,
  dbCredentials,
  kubeconfig,
  liveMode,
  sampleSecret,
  sshCredentials,
  stableHex,
} from "./mock.js";
import {
  type CloudProvisioner,
  type Order,
  ProvisionError,
  type ProvisionResult,
} from "./types.js";

async function provisionLive(order: Order): Promise<ProvisionResult> {
  // ── REAL API: connect here ──────────────────────────────────────────────
  // Set X-Client-Token / deterministic names from order.idempotencyKey so a
  // retry does not create a second resource.
  //
  // storage   esdk-obs-nodejs createBucket + setBucketQuota + IAM sub-user.
  // compute   @huaweicloud/huaweicloud-sdk-ecs createServers (flavorRef from specs).
  // gpu       same with pi2 / p2s flavors (check GPU quota per region).
  // ai-agents ModelArts inference service / Pangu API app behind APIG throttling.
  // database  @huaweicloud/huaweicloud-sdk-gaussdb createInstance (ha = specs).
  // cdn-dns   @huaweicloud/huaweicloud-sdk-cdn createDomain +
  //           @huaweicloud/huaweicloud-sdk-dns createPublicZone.
  // backup    @huaweicloud/huaweicloud-sdk-cbr createVault + createPolicy
  //           (retention_duration_days = specs.retention_days).
  // kubernetes@huaweicloud/huaweicloud-sdk-cce createCluster + createNodePool.
  // security  WAF createHost | Anti-DDoS (CNAD) protected objects |
  //           Config + SecMaster baseline checks.
  throw new ProvisionError(
    `Huawei live provisioning for ${order.item.category} is not connected yet`,
    false,
  );
}

function provisionMock(order: Order): ProvisionResult {
  const { item, region } = order;
  const id = stableHex(order, "huawei");
  const base = {
    region,
    status: "active" as const,
    expiresAt: contractEnd(order),
    mock: true,
  };
  const console = (svc: string, hash = "") => `https://console-intl.huaweicloud.com/${svc}/?region=${region}${hash}`;
  switch (item.category) {
    case "storage": {
      const bucket = `ccm-${id}`;
      return {
        ...base,
        resourceId: `obs:${region}:${bucket}`,
        endpoint: `https://${bucket}.obs.${region}.myhuaweicloud.com`,
        consoleUrl: console("console", "#/obs/manager/buckets"),
        credentials: {
          HUAWEICLOUD_AK: `MOCKAK${id.toUpperCase()}`,
          HUAWEICLOUD_SK: sampleSecret(order, "obs"),
        },
        details: { bucket, quota_gb: item.specs.capacity_gb, storage_class: item.specs.storage_class },
      };
    }
    case "compute":
    case "gpu":
      return {
        ...base,
        resourceId: `${id.slice(0, 8)}-${id.slice(8, 12)}-4000-8000-${stableHex(order, "ecs-uuid")}`,
        endpoint: `119.8.${parseInt(id.slice(0, 2), 16) % 250}.${parseInt(id.slice(2, 4), 16) % 250}`,
        consoleUrl: console("ecm", "#/ecs/manager/vmList"),
        credentials: sshCredentials(order, "root"),
        details: { flavor: item.specs.instance_type, vcpu: item.specs.vcpu, memory_gb: item.specs.memory_gb, gpu: item.specs.gpu ?? null, term: order.term },
      };
    case "ai-agents":
      return {
        ...base,
        resourceId: `modelarts:${region}:service/ccm-${id}`,
        endpoint: `https://ccm-${id}.apig.${region}.huaweicloudapis.com/v1/infers`,
        consoleUrl: console("modelarts"),
        credentials: { APP_KEY: `MOCK${id}`, APP_SECRET: sampleSecret(order, "modelarts") },
        details: { agents: item.specs.agents, invocations_month: item.specs.invocations_month, model: item.specs.model },
      };
    case "database":
      return {
        ...base,
        resourceId: `gaussdb:${region}:instance/ccm-${id}`,
        endpoint: `ccm-${id}.gaussdb.${region}.myhuaweicloud.com:8000`,
        consoleUrl: console("gaussdb"),
        credentials: dbCredentials(order, "root"),
        details: { engine: "GaussDB", flavor: item.specs.instance_class, storage_gb: item.specs.storage_gb, ha: item.specs.high_availability },
      };
    case "cdn-dns":
      return {
        ...base,
        resourceId: `cdn:global:domain/ccm-${id}`,
        endpoint: `https://ccm-${id}.c.cdnhwc1.com`,
        consoleUrl: console("cdn"),
        credentials: { HUAWEICLOUD_AK: `MOCKAK${id.toUpperCase()}`, HUAWEICLOUD_SK: sampleSecret(order, "cdn") },
        details: { traffic_tb_month: item.specs.traffic_tb_month, nameservers: ["ns1.huaweicloud-dns.com", "ns1.huaweicloud-dns.cn"] },
      };
    case "backup":
      return {
        ...base,
        resourceId: `cbr:${region}:vault/ccm-${id}`,
        endpoint: console("cbr"),
        consoleUrl: console("cbr"),
        credentials: {},
        details: { retention_days: item.specs.retention_days, schedule: "diario 03:00 UTC", protected_gb: item.specs.protected_gb },
      };
    case "kubernetes": {
      const server = `https://${id}.cce.${region}.myhuaweicloud.com:5443`;
      return {
        ...base,
        resourceId: `cce:${region}:cluster/ccm-${id}`,
        endpoint: server,
        consoleUrl: console("cce2.0"),
        credentials: kubeconfig(order, server, `ccm-${id}`),
        details: { nodes: item.specs.nodes, flavor: item.specs.node_type, version: "v1.31" },
      };
    }
    case "security":
      return {
        ...base,
        resourceId: `${item.plan === "WAF" ? "waf" : item.plan === "Anti-DDoS" ? "aad" : "secmaster"}:${region}:ccm-${id}`,
        endpoint: console(item.plan === "WAF" ? "waf" : item.plan === "Anti-DDoS" ? "aad" : "secmaster"),
        consoleUrl: null,
        credentials: {},
        details: { protection: item.plan, ...item.specs },
      };
    case "credits":
    case "consulting":
      throw new ProvisionError(`${item.category} is fulfilled by the services adapter`, false);
  }
}

export const huaweiProvisioner: CloudProvisioner = {
  provider: "huawei",
  async provision(order) {
    return liveMode() ? provisionLive(order) : provisionMock(order);
  },
  async deprovision(order, result) {
    // REAL API: delete `result.resourceId` (deleteServers, deleteBucket, ...).
    if (liveMode()) {
      throw new ProvisionError(`Huawei live deprovision of ${result.resourceId} is not connected yet`, true);
    }
    console.log(`[fulfillment.huawei] mock deprovision ${order.orderId} → ${result.resourceId}`);
  },
};
