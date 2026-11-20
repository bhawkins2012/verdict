// Which products are in the catalog and which are public (docs/adr-generation-run.md D2, D10; review B1, 3).
import { CatalogStatus, Prisma } from '@prisma/client'
import { isDevEnvironment } from '../middleware/devOnly'

/**
 * In a node's catalog: approved by the run's checks or by an admin. A product added by a user through
 * POST /api/products is approved for its own page (approvedVia null) but is not in the catalog until an
 * admin approves it, so it is never listed or counted in the publish gate on its own.
 */
export const IN_CATALOG = {
  catalogStatus: CatalogStatus.APPROVED,
  approvedVia: { not: null },
} satisfies Prisma.ProductWhereInput

/**
 * Public product pages and GET /api/products: products listed by a publish, or added by a user (not
 * discovered by a run) and not rejected. Discovered products are public only once a publish lists them,
 * and dry-run products never outside development and test.
 */
export function publicProductWhere(): Prisma.ProductWhereInput {
  return {
    OR: [{ listed: true }, { discoveredByRunId: null, catalogStatus: { not: CatalogStatus.REJECTED } }],
    ...(isDevEnvironment() ? {} : { isDryRun: false }),
  }
}

/**
 * What one viewer can see: public products, plus any product the viewer already reviews (has a thread
 * for). A product rejected or unlisted after someone started reviewing it stays reviewable by them, so
 * their check-ins keep working; it is gone only for everyone else.
 */
export function visibleProductWhere(userId: string | undefined): Prisma.ProductWhereInput {
  return userId ? { OR: [publicProductWhere(), { reviewThreads: { some: { userId } } }] } : publicProductWhere()
}
