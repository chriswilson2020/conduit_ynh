import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  BASE_PATH: z.string().startsWith("/").default("/"),
  APP_VERSION: z.string().default("0.0.0-dev"),
  CONDUIT_DEV_USER: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default("./data"),
  DEFAULT_CURRENCY: z.string()
    .regex(/^[A-Z]{3}$/, "DEFAULT_CURRENCY must be 3 uppercase letters")
    .default("EUR"),
});

export interface Config {
  nodeEnv: z.infer<typeof envSchema>["NODE_ENV"];
  port: number;
  databaseUrl: string;
  /** Public path the app is mounted at, without a trailing slash. "/" stays "/". */
  basePath: string;
  version: string;
  /** Username to assume when no SSOwat header is present. Never set in production. */
  devUser: string | null;
  dataDir: string;
  /** Applied by the deals service when a caller creates a deal without a currency. */
  defaultCurrency: string;
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${detail}`);
  }
  const value = parsed.data;

  // This guard only fires when NODE_ENV is exactly "production". NODE_ENV defaults to
  // "development" when unset, so a deployment that forgets to set NODE_ENV=production
  // would boot with CONDUIT_DEV_USER set and silently bypass authentication. This file
  // does not enforce that NODE_ENV is set explicitly in production — the systemd unit
  // and the .env template are responsible for that (and `npm run dev` relies on the
  // "development" default, so requiring it here would break local development).
  if (value.NODE_ENV === "production" && value.CONDUIT_DEV_USER !== undefined) {
    throw new Error(
      "CONDUIT_DEV_USER must not be set when NODE_ENV=production: it bypasses SSO authentication",
    );
  }

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    basePath: value.BASE_PATH === "/" ? "/" : value.BASE_PATH.replace(/\/+$/, "") || "/",
    version: value.APP_VERSION,
    devUser: value.CONDUIT_DEV_USER ?? null,
    dataDir: value.DATA_DIR,
    defaultCurrency: value.DEFAULT_CURRENCY,
  };
}
