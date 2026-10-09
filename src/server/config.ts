import { resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  publicUrl: string;
  dbPath: string;
  cuelightUrl: string;
  cuelightToken: string;
  cuelightCaFile?: string;
}

export const defaultDbPath = resolve(import.meta.dirname, "../../data/cable.db");

export function dbPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.CABLE_DB_PATH?.trim() || defaultDbPath;
}

/** Reads server configuration from the environment; throws listing every missing variable. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing = ["CUELIGHT_URL", "CUELIGHT_TOKEN"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new Error(`missing required environment: ${missing.join(", ")}`);
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT?.trim() || "4190");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a TCP port, got ${env.PORT}`);
  return {
    host,
    port,
    publicUrl: (env.CABLE_PUBLIC_URL?.trim() || `http://${host.includes(":") ? `[${host}]` : host}:${port}`).replace(/\/+$/, ""),
    dbPath: dbPathFromEnv(env),
    cuelightUrl: env.CUELIGHT_URL!.trim().replace(/\/+$/, ""),
    cuelightToken: env.CUELIGHT_TOKEN!.trim(),
    cuelightCaFile: env.CUELIGHT_CA_FILE?.trim() || undefined,
  };
}
