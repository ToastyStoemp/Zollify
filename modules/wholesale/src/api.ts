import type { OrderInput, OrderStatus, TradeCustomer, TradeCustomerInput, TradeDetails, WholesaleOrder } from '@zollify/shared';
import { sdk } from './runtime';

/** Typed wrapper over this module's server half at `/api/m/wholesale/…`. */

export const api = {
  details: () => sdk().http.get<{ details: Record<string, TradeDetails> }>('products'),
  saveDetails: (productId: string, d: TradeDetails) => sdk().http.put<{ details: TradeDetails }>(`products/${encodeURIComponent(productId)}`, d),
  clearDetails: (productId: string) => sdk().http.del<{ ok: true }>(`products/${encodeURIComponent(productId)}`),
  customers: () => sdk().http.get<{ customers: TradeCustomer[] }>('customers'),
  addCustomer: (c: TradeCustomerInput) => sdk().http.post<{ customer: TradeCustomer }>('customers', c),
  saveCustomer: (id: string, c: TradeCustomerInput) => sdk().http.put<{ customer: TradeCustomer }>(`customers/${id}`, c),
  removeCustomer: (id: string) => sdk().http.del<{ ok: true }>(`customers/${id}`),
  orders: () => sdk().http.get<{ orders: WholesaleOrder[]; reserved: Record<string, number> }>('orders'),
  addOrder: (o: OrderInput) => sdk().http.post<{ order: WholesaleOrder }>('orders', o),
  saveOrder: (id: string, o: OrderInput) => sdk().http.put<{ order: WholesaleOrder }>(`orders/${id}`, o),
  setStatus: (id: string, status: OrderStatus, saleId?: string) => sdk().http.post<{ order: WholesaleOrder }>(`orders/${id}/status`, { status, ...(saleId ? { saleId } : {}) }),
  removeOrder: (id: string) => sdk().http.del<{ ok: true }>(`orders/${id}`),
};

export async function loadOrders(): Promise<{ orders: WholesaleOrder[]; customers: TradeCustomer[]; reserved: Record<string, number> }> {
  const [o, c] = await Promise.all([api.orders(), api.customers()]);
  return { orders: o.orders, reserved: o.reserved, customers: c.customers };
}

export function errorText(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: string } } | null)?.body;
  if (body?.message) return body.message;
  return err instanceof Error && err.message ? err.message : fallback;
}
