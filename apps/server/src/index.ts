import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EOL } from 'node:os';
import { join, resolve } from 'node:path';
import { buildGateway, loadDotEnv, type ServerModule } from '@zollify/server-core';
import { shopifyServerModule } from './modules/shopify-sync';
import { sourcingServerModule } from './modules/sourcing';
import { publicEventsServerModule } from './modules/public-events';
import { priceCardsServerModule } from './modules/price-cards';
import { taxServerModule } from './modules/tax/index';

loadDotEnv();

/**
 * Server module halves are compiled into this deploy (assembled in main()).
 *
 * Unlike client modules, these are not loaded at runtime: they run in a
 * privileged process holding the database and every tenant's integration keys,
 * and downloading code into that process would be an entirely different
 * security proposition. They are gated per account instead - see
 * `mountServerModules`.
 */


/** What a brand-new account starts with, so it isn't an empty shell. */
const DEFAULT_MODULES = ['pos', 'customs-ch'];

/**
 * The signing secret, minted once and kept in the data volume when the
 * environment does not set one. It lives next to the database it signs for,
 * so backups and restores carry it along; regenerating it would sign every
 * device out and make the encrypted Shopify credentials unreadable.
 */
function persistentSecret(dataDir: string): string {
  const file = join(dataDir, 'jwt-secret');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) return stored;
  }
  mkdirSync(dataDir, { recursive: true });
  const fresh = randomBytes(48).toString('base64url');
  writeFileSync(file, fresh + EOL, { mode: 0o600 });
  return fresh;
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
  // Android self-update APKs (written by `npm run android:pack` or scripts/fetch-apks.mjs).
  const apkDir = resolve(process.env.ZOLLIFY_APK_DIR ?? './apk');
  // Content-only shell updates for @capgo/capacitor-updater (written by `npm run publish:shell`).
  const shellStoreDir = resolve(process.env.ZOLLIFY_SHELL_STORE ?? './shell-store');
  const jwtSecret = process.env.ZOLLIFY_JWT_SECRET || persistentSecret(dataDir);

  // Shopify derives its credential-encryption key from the same secret, so it
  // is constructed here rather than importing config of its own.
  const serverModules: ServerModule[] = [
    taxServerModule(jwtSecret),
    sourcingServerModule,
    publicEventsServerModule,
    priceCardsServerModule,
    shopifyServerModule(jwtSecret),
  ];

  const app = await buildGateway({
    dataDir,
    moduleStoreDir,
    webDistDir,
    apkDir,
    shellStoreDir,
    deployDir: process.env.ZOLLIFY_DEPLOY_DIR ? resolve(process.env.ZOLLIFY_DEPLOY_DIR) : undefined,
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

  // Under `tsx watch` the previous process can still hold the port for a
  // moment (open WebSockets delay its exit), so the port is retried briefly
  // rather than the restart dying on EADDRINUSE and leaving stale code up.
  for (let attempt = 1; ; attempt++) {
    try {
      await app.listen({ port, host });
      break;
    } catch (err) {
      const busy = err instanceof Error && 'code' in err && (err as { code?: string }).code === 'EADDRINUSE';
      if (!busy || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  app.log.info({ port, host, dataDir, moduleStoreDir, webDistDir }, 'Zollify gateway listening');
}

main().catch((err) => {
  console.error('[zollify] failed to start:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
