/**
 * Azure adapter — Blob Storage, Virtual Machines, AI Foundry, Azure SQL,
 * Front Door + DNS, Azure Backup, GPU VMs, AKS, WAF / DDoS / Defender CSPM.
 *
 * Runs with the OPERATOR's subscription via DefaultAzureCredential
 * (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET or managed
 * identity) and AZURE_SUBSCRIPTION_ID. Buyer credentials are never accepted.
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
  // Azure ARM PUTs are idempotent by resource NAME — derive every name from
  // order.idempotencyKey so a retry converges on the same resource.
  //
  // storage   @azure/arm-storage storageAccounts.beginCreateAndWait + container SAS.
  // compute   @azure/arm-compute virtualMachines.beginCreateOrUpdateAndWait.
  // gpu       same with NC-series sizes (check regional GPU quota).
  // ai-agents @azure/arm-cognitiveservices accounts/projects (AI Foundry).
  // database  @azure/arm-sql servers.beginCreateOrUpdateAndWait +
  //           databases.beginCreateOrUpdateAndWait(sku from specs).
  // cdn-dns   @azure/arm-cdn profiles/afdEndpoints (Front Door Standard) +
  //           @azure/arm-dns zones.createOrUpdate.
  // backup    @azure/arm-recoveryservices vaults + @azure/arm-recoveryservicesbackup
  //           protectionPolicies (daily, retention = specs.retention_days).
  // kubernetes@azure/arm-containerservice managedClusters.beginCreateOrUpdateAndWait
  //           (agentPool count = specs.nodes) → listClusterUserCredentials.
  // security  @azure/arm-frontdoor WAF policy | @azure/arm-network
  //           ddosProtectionPlans | @azure/arm-security pricings (Defender CSPM).
  throw new ProvisionError(
    `Azure live provisioning for ${order.item.category} is not connected yet`,
    false,
  );
}

function provisionMock(order: Order): ProvisionResult {
  const { item, region } = order;
  const id = stableHex(order, "azure", 10);
  const rg = `ccm-${id}`;
  const arm = (type: string, name: string) =>
    `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${rg}/providers/${type}/${name}`;
  const base = {
    region,
    status: "active" as const,
    expiresAt: contractEnd(order),
    consoleUrl: `https://portal.azure.com/#@/resource/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${rg}`,
    mock: true,
  };
  switch (item.category) {
    case "storage": {
      const account = `ccm${id}`;
      return {
        ...base,
        resourceId: arm("Microsoft.Storage/storageAccounts", account),
        endpoint: `https://${account}.blob.core.windows.net/data`,
        credentials: { SAS_TOKEN: `sv=2024-11-04&sr=c&sp=racwdl&sig=${sampleSecret(order, "sas")}` },
        details: { storage_account: account, container: "data", quota_gb: item.specs.capacity_gb, tier: item.specs.tier },
      };
    }
    case "compute":
    case "gpu":
      return {
        ...base,
        resourceId: arm("Microsoft.Compute/virtualMachines", `vm-${id}`),
        endpoint: `vm-${id}.${region}.cloudapp.azure.com`,
        credentials: sshCredentials(order, "azureuser"),
        details: { vm_size: item.specs.instance_type, vcpu: item.specs.vcpu, memory_gb: item.specs.memory_gb, gpu: item.specs.gpu ?? null, term: order.term },
      };
    case "ai-agents":
      return {
        ...base,
        resourceId: `${arm("Microsoft.CognitiveServices/accounts", `ccm-${id}`)}/projects/agents`,
        endpoint: `https://ccm-${id}.services.ai.azure.com/api/projects/agents`,
        credentials: { API_KEY: sampleSecret(order, "foundry") },
        details: { agents: item.specs.agents, invocations_month: item.specs.invocations_month, model: item.specs.model },
      };
    case "database":
      return {
        ...base,
        resourceId: `${arm("Microsoft.Sql/servers", `ccm-${id}`)}/databases/app`,
        endpoint: `ccm-${id}.database.windows.net:1433`,
        credentials: dbCredentials(order, "ccmadmin"),
        details: { engine: "Azure SQL", sku: item.specs.instance_class, storage_gb: item.specs.storage_gb, zone_redundant: item.specs.high_availability },
      };
    case "cdn-dns":
      return {
        ...base,
        resourceId: arm("Microsoft.Cdn/profiles", `ccm-${id}`),
        endpoint: `https://ccm-${id}.z01.azurefd.net`,
        credentials: { PURGE_SP_SECRET: sampleSecret(order, "afd") },
        details: { traffic_tb_month: item.specs.traffic_tb_month, dns_zone: `ccm-${id}.example`, nameservers: ["ns1-01.azure-dns.com", "ns2-01.azure-dns.net"] },
      };
    case "backup":
      return {
        ...base,
        resourceId: arm("Microsoft.RecoveryServices/vaults", `ccm-${id}`),
        endpoint: base.consoleUrl,
        credentials: {},
        details: { retention_days: item.specs.retention_days, schedule: "diario 03:00 UTC", protected_gb: item.specs.protected_gb },
      };
    case "kubernetes": {
      const server = `https://ccm-${id}-dns.hcp.${region}.azmk8s.io:443`;
      return {
        ...base,
        resourceId: arm("Microsoft.ContainerService/managedClusters", `ccm-${id}`),
        endpoint: server,
        credentials: kubeconfig(order, server, `ccm-${id}`),
        details: { nodes: item.specs.nodes, node_size: item.specs.node_type, version: "1.31" },
      };
    }
    case "security":
      return {
        ...base,
        resourceId: arm(
          item.plan === "WAF" ? "Microsoft.Network/frontDoorWebApplicationFirewallPolicies" : item.plan === "Anti-DDoS" ? "Microsoft.Network/ddosProtectionPlans" : "Microsoft.Security/pricings",
          `ccm${id}`,
        ),
        endpoint: base.consoleUrl,
        credentials: {},
        details: { protection: item.plan, ...item.specs },
      };
    case "credits":
    case "consulting":
      throw new ProvisionError(`${item.category} is fulfilled by the services adapter`, false);
  }
}

export const azureProvisioner: CloudProvisioner = {
  provider: "azure",
  async provision(order) {
    return liveMode() ? provisionLive(order) : provisionMock(order);
  },
  async deprovision(order, result) {
    // REAL API: delete the resource group `ccm-<id>` (resourceGroups.beginDeleteAndWait).
    if (liveMode()) {
      throw new ProvisionError(`Azure live deprovision of ${result.resourceId} is not connected yet`, true);
    }
    console.log(`[fulfillment.azure] mock deprovision ${order.orderId} → ${result.resourceId}`);
  },
};
