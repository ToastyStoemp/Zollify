/**
 * @zollify/server-core - the gateway and everything a deployment composes.
 */
// Side-effect import: installs the Fastify decorator typings every consumer
// needs, including apps that compile these sources directly.
import './fastify-augment';

export { buildGateway, type GatewayOptions } from './app';
export { openDb, bumpMetric, touchDevice, type MetricField } from './db';
export {
  authenticate,
  authenticateApiOrJwt,
  authenticateApiWrite,
  registerAuthRoutes,
  seedOwner,
  parseAllowedEvents,
  parseProfile,
  type JwtClaims,
} from './auth';
export {
  migrateEntitlements,
  listForAccount,
  enabledIds,
  isEnabled,
  setEnabled,
  seedDefaults,
  type AccountModule,
} from './modules/entitlements';
export {
  loadModuleStore,
  toDescriptor,
  type PublishedModule,
  type ModuleManifestFile,
} from './modules/registry';
export {
  mountServerModules,
  mountPublicModules,
  type PublicModuleContext,
  type ServerModule,
  type ModuleContext,
  type ModuleServices,
  type RequestIdentity,
  type Role,
} from './modules/mount';
export { registerModuleRoutes } from './routes/modules';
export { appendOps, type ServerOpInput } from './routes/sync';
export { createMailer, isPlainEmail, type Mailer, type MailMessage } from './mailer';
export { createNotifier, type Notify, type NotificationInput } from './notifications';
export { createWebhooks, webhookTargetProblem, type Webhooks, type ReportContributor } from './webhooks';
export { registerRefreshCookie, REFRESH_COOKIE, type RefreshCookieOptions } from './refresh-cookie';
export { loadDotEnv } from './env';
export { issueChallenge, verifyChallenge, type ChallengePurpose } from './captcha';
export { makeSecretBox, type SecretBox } from './secretbox';
export { registerStatic, type StaticOptions } from './static';
export { reduceEvents, reduceProducts, reduceDiscounts, reduceTransactions, reduceMerges, type ReducibleOp } from './reduce';
export {
  uploadConfig,
  decodeUpload,
  sendRefusal,
  storageUsed,
  checkQuota,
  addStorageSource,
  downloadHeaders,
  registerUploadErrors,
  type UploadConfig,
  type DecodedUpload,
} from './upload-limits';
