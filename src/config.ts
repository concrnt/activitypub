import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface AppConfig {
  server: {
    port: number;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  concrnt: {
    ccid: string;
    domain: string;
    privateKey: string;
  };
  activitypub: {
    baseUrl: string;
  };
}

type ConfigRecord = Record<string, unknown>;

const configPath = fileURLToPath(new URL("../config.yaml", import.meta.url));

const isRecord = (value: unknown): value is ConfigRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectRecord = (value: unknown, path: string): ConfigRecord => {
  if (!isRecord(value)) {
    throw new Error(`Invalid config: "${path}" must be a mapping.`);
  }

  return value;
};

const expectString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid config: "${path}" must be a non-empty string.`);
  }

  return value;
};

const expectNumber = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid config: "${path}" must be a finite number.`);
  }

  return value;
};

const expectHost = (value: unknown, path: string): string => {
  const host = expectString(value, path);

  if (host.includes("://")) {
    throw new Error(
      `Invalid config: "${path}" must be a host or FQDN without a URL scheme.`,
    );
  }

  if (/[/?#]/.test(host)) {
    throw new Error(
      `Invalid config: "${path}" must not include a path, query, or fragment.`,
    );
  }

  new URL(`https://${host}`);

  return host;
};

const readConfig = (): AppConfig => {
  let source: string;

  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to read config file at "${configPath}". Create config.yaml from config.example.yaml. ${reason}`,
    );
  }

  const parsed = parse(source) as unknown;
  const root = expectRecord(parsed, "config");
  const server = expectRecord(root.server, "server");
  const database = expectRecord(root.database, "database");
  const redis = expectRecord(root.redis, "redis");
  const concrnt = expectRecord(root.concrnt, "concrnt");
  const concrntDomain = expectHost(concrnt.domain, "concrnt.domain");
  const activitypubBaseUrl = new URL(`https://${concrntDomain}`).origin;

  const config: AppConfig = {
    server: {
      port: expectNumber(server.port, "server.port"),
    },
    database: {
      url: expectString(database.url, "database.url"),
    },
    redis: {
      url: expectString(redis.url, "redis.url"),
    },
    concrnt: {
      ccid: expectString(concrnt.ccid, "concrnt.ccid"),
      domain: concrntDomain,
      privateKey: expectString(concrnt.privateKey, "concrnt.privateKey"),
    },
    activitypub: {
      baseUrl: activitypubBaseUrl,
    },
  };

  new URL(config.activitypub.baseUrl);

  return Object.freeze(config);
};

export const config = readConfig();
