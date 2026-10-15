import { describe, expect, it } from 'vitest';
import { ContributionRegistry } from '../contributions';

const load = async () => ({ default: {} as never });

describe('setup steps', () => {
  it('lists a role\'s steps in order, namespaced by module', () => {
    const c = new ContributionRegistry();
    c.addSetupStep('pos', { id: 'payments', title: 'Card payments', component: load, order: 20, minRole: 'admin' });
    c.addSetupStep('tax', { id: 'books', title: 'Books', component: load, order: 10 });
    expect(c.setupStepsFor('owner').map((s) => s.id)).toEqual(['tax.books', 'pos.payments']);
    // A helper never sees the account-level steps.
    expect(c.setupStepsFor('member').map((s) => s.id)).toEqual(['tax.books']);
  });

  it('withdraws a module\'s steps with the module', () => {
    const c = new ContributionRegistry();
    c.addSetupStep('pos', { id: 'payments', title: 'Card payments', component: load });
    c.removeModule('pos');
    expect(c.setupStepsFor('owner')).toEqual([]);
  });
});
