import { z } from "zod";

// "30s" | "45m" | "1h" -> seconds
const duration = z
  .string()
  .regex(/^\d+[smh]$/, 'expected a duration like "30s", "45m" or "1h"')
  .transform((v) => {
    const n = Number(v.slice(0, -1));
    const unit = v.slice(-1);
    return n * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  });

const cidr = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, "expected an IPv4 CIDR like 10.42.0.0/16");

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    PORT: z.coerce.number().int().positive().default(3000),

    // Where users reach labs, e.g. https://labs.gurnoor.online (no trailing slash).
    PUBLIC_BASE_URL: z.url().default("http://localhost:8080"),
    // Where users reach the UI/API. Prod: same as PUBLIC_BASE_URL (one host).
    // Local: http://localhost:3000, since the API runs on the Mac, not in k3d.
    APP_BASE_URL: z.url().optional(),
    // Address Traefik's ForwardAuth calls. Local default: the API on the Mac, via
    // the host alias k3d injects into cluster DNS. Unreachable = access denied.
    AUTH_VERIFY_URL: z.url().default("http://host.k3d.internal:3000/auth/verify"),

    // Signs session cookies. 32+ chars; generate with `openssl rand -hex 32`.
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    SESSION_TTL: duration.default(12 * 3600),

    // Google OIDC. Optional so tests and local dev run without a Google client;
    // /auth/login answers 503 until both are set.
    OIDC_ISSUER: z.url().default("https://accounts.google.com"),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    // Host rule on lab Ingresses. Unset locally (match any host).
    INGRESS_HOST: z.string().min(1).optional(),
    INGRESS_CLASS: z.string().default("traefik"),
    // Namespace Traefik runs in; the only source allowed to reach a lab's ttyd port.
    INGRESS_NAMESPACE: z.string().default("kube-system"),

    DATABASE_URL: z.string().min(1),

    LAB_IMAGE: z.string().default("labforge-lab:dev"),
    LAB_IMAGE_PULL_POLICY: z.enum(["Always", "IfNotPresent", "Never"]).default("IfNotPresent"),
    LAB_TTL: duration.default(45 * 60),
    LAB_READY_TIMEOUT: duration.default(60),
    POOL_SIZE: z.coerce.number().int().min(0).default(3),
    // Default 10: 2 nodes x 2 OCPU, ~1 CPU reserved for system pods, 250m request
    // per lab -> ~12 schedulable; 10 leaves headroom. Memory is not the binding limit.
    MAX_CONCURRENT_LABS: z.coerce.number().int().positive().default(10),

    LAB_CPU_REQUEST: z.string().default("250m"),
    LAB_CPU_LIMIT: z.string().default("500m"),
    LAB_MEMORY_REQUEST: z.string().default("256Mi"),
    LAB_MEMORY_LIMIT: z.string().default("512Mi"),
    LAB_EPHEMERAL_REQUEST: z.string().default("256Mi"),
    LAB_EPHEMERAL_LIMIT: z.string().default("512Mi"),

    LAB_INTERNET_EGRESS: z.stringbool().default(true),
    POD_CIDR: cidr.default("10.42.0.0/16"),
    SERVICE_CIDR: cidr.default("10.43.0.0/16"),
    // Required, no default: kube-proxy rewrites the API server's ClusterIP to a
    // node IP *before* NetworkPolicy runs, so excluding only SERVICE_CIDR does not
    // block it. Prod: the VCN subnet. Local: the k3d network (`make dev-up` pins it).
    NODE_CIDR: cidr,
    METADATA_CIDR: cidr.default("169.254.169.254/32"),

    RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),
  })
  .transform((c) => {
    const appBaseUrl = (c.APP_BASE_URL ?? c.PUBLIC_BASE_URL).replace(/\/+$/, "");
    return {
    env: c.NODE_ENV,
    logLevel: c.LOG_LEVEL,
    port: c.PORT,
    publicBaseUrl: c.PUBLIC_BASE_URL.replace(/\/+$/, ""),
    appBaseUrl,
    authVerifyUrl: c.AUTH_VERIFY_URL,
    databaseUrl: c.DATABASE_URL,
    rateLimitPerMin: c.RATE_LIMIT_PER_MIN,
    session: {
      secret: c.SESSION_SECRET,
      ttlSeconds: c.SESSION_TTL,
      // Secure cookies need https; plain-http localhost dev can't set them.
      secureCookie: appBaseUrl.startsWith("https://"),
    },
    oidc: {
      issuer: c.OIDC_ISSUER,
      clientId: c.OIDC_CLIENT_ID,
      clientSecret: c.OIDC_CLIENT_SECRET,
      redirectUri: `${appBaseUrl}/auth/callback`,
    },
    ingress: {
      host: c.INGRESS_HOST,
      className: c.INGRESS_CLASS,
      namespace: c.INGRESS_NAMESPACE,
    },
    lab: {
      image: c.LAB_IMAGE,
      imagePullPolicy: c.LAB_IMAGE_PULL_POLICY,
      ttlSeconds: c.LAB_TTL,
      readyTimeoutSeconds: c.LAB_READY_TIMEOUT,
      poolSize: c.POOL_SIZE,
      maxConcurrent: c.MAX_CONCURRENT_LABS,
      resources: {
        requests: {
          cpu: c.LAB_CPU_REQUEST,
          memory: c.LAB_MEMORY_REQUEST,
          "ephemeral-storage": c.LAB_EPHEMERAL_REQUEST,
        },
        limits: {
          cpu: c.LAB_CPU_LIMIT,
          memory: c.LAB_MEMORY_LIMIT,
          "ephemeral-storage": c.LAB_EPHEMERAL_LIMIT,
        },
      },
    },
    network: {
      internetEgress: c.LAB_INTERNET_EGRESS,
      podCidr: c.POD_CIDR,
      serviceCidr: c.SERVICE_CIDR,
      nodeCidr: c.NODE_CIDR,
      metadataCidr: c.METADATA_CIDR,
    },
    };
  });

export type Config = z.output<typeof envSchema>;

/** Parse + validate env. Throws a readable error listing every bad variable. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
