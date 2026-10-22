/**
 * A link into the till that opens one module's screen over it: `/m/pos?action=<moduleId>:<actionId>&focus=<id>`.
 * A module's own page uses it to send the seller to the till with something
 * picked already - a commission's deposit, say - without importing POS.
 * `focus` is handed to that screen as a prop; what it means is the module's.
 */
export interface TillLink<T> {
  action: T;
  focus: string | null;
}

const one = (v: unknown): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length > 0 && s.length <= 120 ? s : null;
};

/** The action the query names, among those modules contributed; null when it names none. */
export function tillLinkFrom<T extends { id: string; moduleId: string }>(query: Record<string, unknown>, actions: T[]): TillLink<T> | null {
  const key = one(query.action);
  if (!key) return null;
  const [moduleId, id] = key.split(':');
  if (!moduleId || !id) return null;
  // The shell keeps a contributed action's id prefixed with its module ("commissions.commission").
  const action = actions.find((a) => a.moduleId === moduleId && (a.id === `${moduleId}.${id}` || a.id === id));
  return action ? { action, focus: one(query.focus) } : null;
}
