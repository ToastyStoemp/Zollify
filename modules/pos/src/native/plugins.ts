/**
 * Access to the Capacitor native plugins the terminal providers need.
 *
 * Boothly targets the web first, where none of these exist. Rather than guard
 * every call site, each plugin is exposed as a proxy that rejects with a clear
 * message, and `hasNativePlugin` is the single check providers use to decide
 * whether to offer themselves at all. On the web that means myPOS GO2, Carbon,
 * Glass and SumUp simply don't appear in the provider list — manual and the
 * bridge do, and the booth can still sell.
 */

export type NativePluginName =
  | 'MyPos'
  | 'CarbonPayment'
  | 'GlassPayment'
  | 'SumUp'
  | 'DisplayLink'
  | 'ThermalPrinter';

interface CapacitorGlobal {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    isPluginAvailable?: (name: string) => boolean;
    Plugins?: Record<string, unknown>;
  };
}

function capacitor(): CapacitorGlobal['Capacitor'] | undefined {
  return (globalThis as CapacitorGlobal).Capacitor;
}

export function isNativePlatform(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/** True only when the real native implementation is present and callable. */
export function hasNativePlugin(name: NativePluginName): boolean {
  const cap = capacitor();
  if (!cap || cap.isNativePlatform?.() !== true) return false;
  if (typeof cap.isPluginAvailable === 'function') return cap.isPluginAvailable(name);
  return Boolean(cap.Plugins?.[name]);
}

function unavailable(name: NativePluginName): never {
  throw new Error(
    `The ${name} terminal needs the Boothly Android app — it isn't available in a browser.`,
  );
}

/**
 * Returns the live plugin when running natively, otherwise a stand-in whose
 * every method rejects. Providers are expected to gate on `hasNativePlugin`
 * first; this exists so a missed guard fails loudly instead of throwing
 * `undefined is not a function` somewhere deep in a checkout.
 */
function plugin<T extends object>(name: NativePluginName): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const impl = capacitor()?.Plugins?.[name] as Record<string | symbol, unknown> | undefined;
      const method = impl?.[prop];
      if (typeof method === 'function') return (method as (...a: unknown[]) => unknown).bind(impl);
      if (impl && prop in impl) return method;
      return () => unavailable(name);
    },
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MyPos = plugin<any>('MyPos');
export const CarbonPayment = plugin<any>('CarbonPayment');
export const GlassPayment = plugin<any>('GlassPayment');
export const SumUp = plugin<any>('SumUp');
export const DisplayLink = plugin<any>('DisplayLink');
/** Receipt printing. Absent on the web, where receipts print through the browser. */
export const ThermalPrinter = plugin<any>('ThermalPrinter');
