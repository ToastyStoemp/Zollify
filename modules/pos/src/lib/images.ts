import { sdk } from '../runtime';

/**
 * Thumbnail lookup for the tile grid.
 *
 * Routed through the SDK rather than @zollify/platform: a module's only
 * permitted import from the host is @zollify/sdk, and honouring that is what
 * keeps the boundary real.
 */
export async function imageUrl(
  imageId: string | undefined,
  kind: 'thumb' | 'full' = 'thumb',
): Promise<string | null> {
  return sdk().data.images.url(imageId, kind);
}
