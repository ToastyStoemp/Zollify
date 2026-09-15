/**
 * The per-account integration configuration. Each field is one setting the
 * clients read; `secret: true` fields are stored encrypted, masked in the UI
 * and never sent back to a browser.
 *
 * Ported from ZollTax's config-schema. The ZollTool group is gone: events and
 * sales now come straight from the account's own op-log.
 */

export interface ConfigField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  /** Value is a template with [placeholders]. */
  template?: boolean;
  select?: { value: string; label: string }[];
}

export interface ConfigGroup {
  id: string;
  label: string;
  hint: string;
  fields: ConfigField[];
}

const MODE_OPTIONS = [
  { value: '', label: 'Auto (detect from credentials)' },
  { value: 'live', label: 'Live' },
  { value: 'mock', label: 'Mock (test data)' },
];

export const CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: 'lexware',
    label: 'Lexware Office',
    hint: 'Books revenue and fee vouchers. Titles and descriptions accept placeholders - [sales_platform], [event_name], [event_country], [month], [year], [vat_rate], [cluster_id], [total]. Blank = built-in default.',
    fields: [
      { key: 'LEXWARE_API_KEY', label: 'API key', secret: true },
      { key: 'LEXWARE_API_URL', label: 'API URL', placeholder: 'https://api.lexoffice.io/v1' },
      { key: 'LEXWARE_FEE_CATEGORY', label: 'Fee category UUID', hint: 'Expense account for the monthly fees voucher.' },
      { key: 'LEXWARE_DOMESTIC_VAT', label: 'Domestic VAT % (Germany)', placeholder: '19', hint: 'Applied when the event country is Germany; foreign events book at 0%.' },
      { key: 'LEXWARE_EVENT_TITLE_TEMPLATE', label: 'Event revenue - voucher title', template: true, placeholder: 'Revenue - [event_name]' },
      { key: 'LEXWARE_EVENT_DESC_TEMPLATE', label: 'Event revenue - description', template: true, placeholder: 'Point of Sales - [event_name] - [event_country]' },
      { key: 'LEXWARE_ONLINE_TITLE_TEMPLATE', label: 'Online sales - voucher title', template: true, placeholder: 'Revenue - Online Sales' },
      { key: 'LEXWARE_ONLINE_DESC_TEMPLATE', label: 'Online sales - description', template: true, placeholder: '[sales_platform] - [month]' },
      { key: 'LEXWARE_FEE_DESC_TEMPLATE', label: 'Fees - description', template: true, placeholder: '[sales_platform] fees [month]' },
    ],
  },
  {
    id: 'mypos',
    label: 'myPOS Banking API',
    hint: 'Pulls and verifies card transactions against settled data. Credentials come from the myPOS Partner Portal.',
    fields: [
      {
        key: 'MYPOS_GATEWAY_URL',
        label: 'Gateway',
        select: [
          { value: '', label: 'Production' },
          { value: 'https://demo-api-gateway.mypos.com', label: 'Demo / sandbox' },
        ],
        hint: 'Production with live Partner Portal credentials; Demo only for sandbox testing.',
      },
      { key: 'MYPOS_CLIENT_ID', label: 'Integration client ID' },
      { key: 'MYPOS_CLIENT_SECRET', label: 'Integration client secret', secret: true },
      { key: 'MYPOS_MERCHANT_CLIENT_ID', label: 'Merchant client ID' },
      { key: 'MYPOS_MERCHANT_CLIENT_SECRET', label: 'Merchant client secret', secret: true },
      { key: 'MYPOS_PARTNER_ID', label: 'Partner ID', placeholder: 'mps-p-…' },
      { key: 'MYPOS_APPLICATION_ID', label: 'Application ID', placeholder: 'mps-app-…' },
      { key: 'MYPOS_MODE', label: 'Mode', select: MODE_OPTIONS, hint: 'Leave on Auto unless you want to force mock test data.' },
      { key: 'MYPOS_ACCOUNT', label: 'Default account (optional)' },
    ],
  },
  {
    id: 'shopify',
    label: 'Shopify orders',
    hint: 'Pulls online and Shopify POS orders. A custom app with read_orders and read_locations.',
    fields: [
      { key: 'SHOPIFY_SHOP', label: 'Shop domain', placeholder: 'mystore.myshopify.com' },
      { key: 'SHOPIFY_CLIENT_ID', label: 'Client ID' },
      { key: 'SHOPIFY_CLIENT_SECRET', label: 'Client secret', secret: true },
      { key: 'SHOPIFY_ACCESS_TOKEN', label: 'Static access token (optional)', secret: true },
      { key: 'SHOPIFY_API_VERSION', label: 'API version', placeholder: '2024-10' },
      { key: 'SHOPIFY_MODE', label: 'Mode', select: MODE_OPTIONS, hint: 'Leave on Auto unless you want to force mock test data.' },
    ],
  },
  {
    id: 'sumup',
    label: 'SumUp API',
    hint: 'Pulls POS and online transactions. An API key with transactions.history.',
    fields: [
      { key: 'SUMUP_API_KEY', label: 'API key', secret: true },
      { key: 'SUMUP_MERCHANT_CODE', label: 'Merchant code' },
      { key: 'SUMUP_API_URL', label: 'API URL', placeholder: 'https://api.sumup.com' },
      { key: 'SUMUP_MODE', label: 'Mode', select: MODE_OPTIONS, hint: 'Leave on Auto unless you want to force mock test data.' },
    ],
  },
  {
    id: 'ai',
    label: 'Invoice scanning (AI)',
    hint: 'Reads an uploaded invoice PDF to prefill an expense and match its event. The PDF is sent to Anthropic when you scan one; the daily caps bound the cost.',
    fields: [
      { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', secret: true, placeholder: 'sk-ant-…' },
      { key: 'ZOLLIFY_AI_MODEL', label: 'Model', placeholder: 'claude-haiku-4-5', hint: 'Cheap and capable. Change only if you know the model id.' },
      { key: 'ZOLLIFY_AI_DAILY_CALLS', label: 'Daily scan limit', placeholder: '100' },
      { key: 'ZOLLIFY_AI_DAILY_TOKENS', label: 'Daily token limit', placeholder: '2000000' },
    ],
  },
];

export const GROUP_IDS = CONFIG_GROUPS.map((g) => g.id);
export const CONFIG_KEYS = new Set(CONFIG_GROUPS.flatMap((g) => g.fields.map((f) => f.key)));
export const SECRET_KEYS = new Set(CONFIG_GROUPS.flatMap((g) => g.fields.filter((f) => f.secret).map((f) => f.key)));
const GROUP_KEYS = Object.fromEntries(CONFIG_GROUPS.map((g) => [g.id, g.fields.map((f) => f.key)])) as Record<string, string[]>;

/** Values keyed by field, plus which groups are switched on. */
export interface TaxConfig {
  values: Record<string, string>;
  enabled: Record<string, boolean>;
}

export function emptyConfig(): TaxConfig {
  return { values: {}, enabled: {} };
}

export function groupEnabled(cfg: TaxConfig, id: string): boolean {
  return cfg.enabled[id] !== false;
}

/** The values a client reads: a disabled group is as good as unset. */
export function effectiveValues(cfg: TaxConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of GROUP_IDS) {
    if (!groupEnabled(cfg, id)) continue;
    for (const key of GROUP_KEYS[id] ?? []) if (cfg.values[key]) out[key] = cfg.values[key]!;
  }
  return out;
}

/**
 * The browser-safe view: real values for plain keys, and a `<KEY>__set` flag
 * for every secret so the UI can say "saved" without ever seeing it.
 */
export function redactConfig(cfg: TaxConfig): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const key of CONFIG_KEYS) {
    if (SECRET_KEYS.has(key)) out[`${key}__set`] = Boolean(cfg.values[key]);
    else out[key] = cfg.values[key] ?? '';
  }
  return out;
}

export function enabledMap(cfg: TaxConfig): Record<string, boolean> {
  return Object.fromEntries(GROUP_IDS.map((id) => [id, groupEnabled(cfg, id)]));
}

/** Applies an edit: set overrides, clear removes, enabled toggles groups. */
export function applyConfigPatch(
  cfg: TaxConfig,
  patch: { set?: Record<string, unknown>; clear?: string[]; enabled?: Record<string, unknown> },
): TaxConfig {
  const values = { ...cfg.values };
  for (const [key, raw] of Object.entries(patch.set ?? {})) {
    if (!CONFIG_KEYS.has(key)) continue;
    const value = String(raw ?? '').trim();
    // A blank secret means "keep what is saved"; a blank plain value clears it.
    if (SECRET_KEYS.has(key) && !value) continue;
    if (value) values[key] = value;
    else delete values[key];
  }
  for (const key of patch.clear ?? []) if (CONFIG_KEYS.has(key)) delete values[key];
  const enabled = { ...cfg.enabled };
  for (const [id, on] of Object.entries(patch.enabled ?? {})) if (GROUP_IDS.includes(id)) enabled[id] = on !== false;
  return { values, enabled };
}
