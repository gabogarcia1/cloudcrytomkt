/**
 * AWS adapter — S3, EC2, Bedrock AgentCore, RDS, CloudFront + Route 53,
 * AWS Backup, EC2 GPU, EKS, WAF / Shield / Config.
 *
 * Runs with the OPERATOR's AWS account: the default credential chain
 * (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE, or the runtime role).
 * Buyer credentials are never accepted. Each buyer gets an isolated resource
 * plus a narrowly scoped IAM principal.
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
  // Operator credentials only. Derive names / client tokens from
  // order.idempotencyKey so a retried provision converges on one resource.
  //
  // storage   @aws-sdk/client-s3 CreateBucket + IAM user/policy scoped to it.
  // compute   @aws-sdk/client-ec2 RunInstances({ ClientToken: key, ... }).
  // gpu       same as compute with g5/p3 instance types (check GPU quotas).
  // ai-agents @aws-sdk/client-bedrock-agentcore-control CreateAgentRuntime.
  // database  @aws-sdk/client-rds CreateDBInstance({ DBInstanceIdentifier: key,
  //           MultiAZ: specs.high_availability, MasterUserPassword: generated }).
  // cdn-dns   @aws-sdk/client-cloudfront CreateDistribution({ CallerReference: key })
  //           + @aws-sdk/client-route-53 CreateHostedZone({ CallerReference: key }).
  // backup    @aws-sdk/client-backup CreateBackupVault + CreateBackupPlan
  //           (daily rule, DeleteAfterDays = specs.retention_days, copy action).
  // kubernetes@aws-sdk/client-eks CreateCluster + CreateNodegroup(scaling = nodes).
  // security  @aws-sdk/client-wafv2 CreateWebACL | @aws-sdk/client-shield
  //           CreateProtection | @aws-sdk/client-config-service + SecurityHub.
  //
  // Throw ProvisionError(msg, retryable) on failure so the order store and
  // refund path classify it correctly.
  throw new ProvisionError(
    `AWS live provisioning for ${order.item.category} is not connected yet`,
    false,
  );
}

function provisionMock(order: Order): ProvisionResult {
  const { item, region } = order;
  const id = stableHex(order, "aws");
  const base = {
    region,
    status: "active" as const,
    expiresAt: contractEnd(order),
    mock: true,
  };
  const console = (path: string) => `https://${region}.console.aws.amazon.com/${path}?region=${region}`;
  switch (item.category) {
    case "storage": {
      const bucket = `ccm-${id}`;
      return {
        ...base,
        resourceId: `arn:aws:s3:::${bucket}`,
        endpoint: `https://${bucket}.s3.${region}.amazonaws.com`,
        consoleUrl: `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?region=${region}`,
        credentials: {
          AWS_ACCESS_KEY_ID: `AKIAMOCK${id.toUpperCase().slice(0, 12)}`,
          AWS_SECRET_ACCESS_KEY: sampleSecret(order, "s3"),
        },
        details: { bucket, quota_gb: item.specs.capacity_gb, storage_class: item.specs.storage_class },
      };
    }
    case "compute":
    case "gpu": {
      const instanceId = `i-0${id.slice(0, 16)}`;
      return {
        ...base,
        resourceId: instanceId,
        endpoint: `ec2-203-0-113-${parseInt(id.slice(0, 2), 16) % 250}.${region}.compute.amazonaws.com`,
        consoleUrl: `${console("ec2/home")}#InstanceDetails:instanceId=${instanceId}`,
        credentials: sshCredentials(order, "ubuntu"),
        details: { instance_type: item.specs.instance_type, vcpu: item.specs.vcpu, memory_gb: item.specs.memory_gb, gpu: item.specs.gpu ?? null, term: order.term },
      };
    }
    case "ai-agents":
      return {
        ...base,
        resourceId: `arn:aws:bedrock-agentcore:${region}:000000000000:runtime/ccm_${id}`,
        endpoint: `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/ccm_${id}/invocations`,
        consoleUrl: console("bedrock-agentcore/home"),
        credentials: {
          OAUTH_CLIENT_ID: `ccm-${id}`,
          OAUTH_CLIENT_SECRET: sampleSecret(order, "agentcore"),
        },
        details: { agents: item.specs.agents, invocations_month: item.specs.invocations_month },
      };
    case "database":
      return {
        ...base,
        resourceId: `arn:aws:rds:${region}:000000000000:db:ccm-${id}`,
        endpoint: `ccm-${id}.c0mock.${region}.rds.amazonaws.com:5432`,
        consoleUrl: console("rds/home"),
        credentials: dbCredentials(order),
        details: { engine: "postgres 16", instance_class: item.specs.instance_class, storage_gb: item.specs.storage_gb, multi_az: item.specs.high_availability },
      };
    case "cdn-dns":
      return {
        ...base,
        resourceId: `arn:aws:cloudfront::000000000000:distribution/E${id.toUpperCase().slice(0, 13)}`,
        endpoint: `https://d${id.slice(0, 13)}.cloudfront.net`,
        consoleUrl: "https://console.aws.amazon.com/cloudfront/v4/home",
        credentials: {
          AWS_ACCESS_KEY_ID: `AKIAMOCK${id.toUpperCase().slice(0, 12)}`,
          AWS_SECRET_ACCESS_KEY: sampleSecret(order, "cdn"),
        },
        details: { traffic_tb_month: item.specs.traffic_tb_month, hosted_zone_id: `Z${id.toUpperCase().slice(0, 13)}`, nameservers: ["ns-101.awsdns-12.com", "ns-602.awsdns-07.net"] },
      };
    case "backup":
      return {
        ...base,
        resourceId: `arn:aws:backup:${region}:000000000000:backup-vault:ccm-${id}`,
        endpoint: console("backup/home"),
        consoleUrl: console("backup/home"),
        credentials: { RESTORE_ROLE_EXTERNAL_ID: sampleSecret(order, "backup") },
        details: { retention_days: item.specs.retention_days, schedule: "cron(0 3 * * ? *)", protected_gb: item.specs.protected_gb },
      };
    case "kubernetes": {
      const server = `https://${id.toUpperCase()}.gr7.${region}.eks.amazonaws.com`;
      return {
        ...base,
        resourceId: `arn:aws:eks:${region}:000000000000:cluster/ccm-${id}`,
        endpoint: server,
        consoleUrl: console("eks/home"),
        credentials: kubeconfig(order, server, `ccm-${id}`),
        details: { nodes: item.specs.nodes, node_type: item.specs.node_type, version: "1.31" },
      };
    }
    case "security":
      return {
        ...base,
        resourceId: `arn:aws:${item.plan === "WAF" ? "wafv2" : item.plan === "Anti-DDoS" ? "shield" : "config"}:${region}:000000000000:ccm-${id}`,
        endpoint: console(item.plan === "WAF" ? "wafv2/homev2" : item.plan === "Anti-DDoS" ? "wafv2/shieldv2" : "securityhub/home"),
        consoleUrl: null,
        credentials: {},
        details: { protection: item.plan, ...item.specs },
      };
    case "credits":
    case "consulting":
      throw new ProvisionError(`${item.category} is fulfilled by the services adapter`, false);
  }
}

export const awsProvisioner: CloudProvisioner = {
  provider: "aws",
  async provision(order) {
    return liveMode() ? provisionLive(order) : provisionMock(order);
  },
  async deprovision(order, result) {
    // REAL API: terminate/delete `result.resourceId` (TerminateInstances,
    // DeleteDBInstance, DeleteDistribution, DeleteCluster, ...).
    if (liveMode()) {
      throw new ProvisionError(`AWS live deprovision of ${result.resourceId} is not connected yet`, true);
    }
    console.log(`[fulfillment.aws] mock deprovision ${order.orderId} → ${result.resourceId}`);
  },
};
