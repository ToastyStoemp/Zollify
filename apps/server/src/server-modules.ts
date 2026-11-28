import type { ServerModule } from '@zollify/server-core';
import { shopifyServerModule } from './modules/shopify-sync';
import { sourcingServerModule } from './modules/sourcing';
import { publicEventsServerModule } from './modules/public-events';
import { commissionsServerModule } from './modules/commissions';
import { priceCardsServerModule } from './modules/price-cards';
import { taxServerModule } from './modules/tax/index';
import { receiptsServerModule } from './modules/receipts';
import { consignmentArtistServerModule, consignmentServerModule } from './modules/consignment';
import { peppolServerModule } from './modules/peppol-be';
import { economicServerModule } from './modules/economic';
import { taxDeadlinesServerModule } from './modules/tax-deadlines';
import { wholesaleServerModule } from './modules/wholesale';
import { loyaltyServerModule } from './modules/loyalty';
import { printDeskServerModule } from './modules/print-desk';

/**
 * Every server module half compiled into this deploy, in one place: the
 * server mounts this list, and the erasure tests check the whole database it
 * creates against what the modules declared they keep per account.
 *
 * Several modules derive their credential-encryption key from the signing
 * secret, so they are constructed here rather than importing config of their own.
 */
export function serverModules(jwtSecret: string): ServerModule[] {
  return [
    taxServerModule(jwtSecret),
    sourcingServerModule,
    publicEventsServerModule,
    priceCardsServerModule,
    shopifyServerModule(jwtSecret),
    receiptsServerModule(jwtSecret),
    consignmentServerModule,
    consignmentArtistServerModule,
    commissionsServerModule,
    peppolServerModule(jwtSecret),
    economicServerModule(jwtSecret),
    taxDeadlinesServerModule,
    wholesaleServerModule,
    loyaltyServerModule(jwtSecret),
    printDeskServerModule,
  ];
}
