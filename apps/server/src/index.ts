import { resolve } from 'node:path';
import { buildGateway, loadDotEnv, type ServerModule } from '@zollify/server-core';
import { shopifyServerModule } from './modules/shopify-sync';
import { sourcingServerModule } from './modules/sourcing';
import { publicEventsServerModule } from './modules/public-events';
import { taxServerModule } from './modules/tax';

loadDotEnv();

/**
 * Server module halves are compiled into this deploy (assembled in main()).
 *
 * Unlike client modules, these are not loaded at runtime: they run in a
 * privileged process holding the database and every tenant's integration keys,
 * and downloading code into that process would be an entirely different
 * security proposition. They are gated per account instead — see
 * `mountServerModules`.
 */


/** What a brand-new account starts with, so it isn't an empty shell. */
const DEFAULT_MODULES = ['pos', 'customs'];

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Failing at boot is the point: a server that silently generates its own
    // signing key would invalidate every session on each restart, and a
    // predictable fallback would be far worse.
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

async function main(): Promise<void> {
  const dataDir = resolve(process.env.ZOLLIFY_DATA_DIR ?? './data');
  const moduleStoreDir = resolve(process.env.ZOLLIFY_MODULE_STORE ?? './modules-store');
  const webDistDir = process.env.ZOLLIFY_WEB_DIST ? resolve(process.env.ZOLLIFY_WEB_DIST) : undefined;
  const jwtSecret = required('ZOLLIFY_JWT_SECRET');

  // Shopify derives its credential-encryption key from the same secret, so it
  // is constructed here rather than importing config of its own.
  const serverModules: ServerModule[] = [
    taxServerModule,
    sourcingServerModule,
    publicEventsServerModule,
    shopifyServerModule(jwtSecret),
  ];

  const app = await buildGateway({
    dataDir,
    moduleStoreDir,
    webDistDir,
    jwtSecret,
    serverModules,
    defaultModules: DEFAULT_MODULES,
    allowedOrigins: (process.env.ZOLLIFY_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    requireHttps: flag('ZOLLIFY_REQUIRE_HTTPS', true),
    trustProxy: flag('ZOLLIFY_TRUST_PROXY', true),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  });

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  app.log.info({ port, host, dataDir, moduleStoreDir, webDistDir }, 'Zollify gateway listening');
}

main().catch((err) => {
  console.error('[zollify] failed to start:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
