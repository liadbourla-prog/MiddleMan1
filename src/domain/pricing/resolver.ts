import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes, servicePriceTiers } from '../../db/schema.js'

export interface PriceResolution {
  amount: number | null
  currency: string
  tier: string | null
  source: 'tier' | 'instance' | 'service' | 'none'
}

export interface PriceResolutionParams {
  serviceTypeId: string
  currency: string
  /** The tier the caller is eligible for (e.g. 'member'). Null/undefined today for
   *  every customer — membership eligibility is Tier-B and not yet wired, so the
   *  tier step is inert unless a caller explicitly names a tier. */
  tierEligibility?: string | null
  /** A price set on the specific class instance/series, if any. */
  instanceOverride?: number | null
}

/**
 * Resolve the price of a bookable occurrence by walking the fixed CRM_STANDARD.md
 * §4 chain and stopping at the first hit:
 *   1. eligible tier  2. instance/series override  3. service base  4. none
 * This is the ONLY place price is resolved — no channel reads payment_amount
 * directly (CRM_STANDARD.md §8.2 "one reader per fact").
 */
export async function resolveServicePrice(
  db: Db,
  businessId: string,
  params: PriceResolutionParams,
): Promise<PriceResolution> {
  const { serviceTypeId, currency } = params

  // 1. Eligible tier
  if (params.tierEligibility) {
    const [tierRow] = await db
      .select({ amount: servicePriceTiers.amount, currency: servicePriceTiers.currency })
      .from(servicePriceTiers)
      .where(
        and(
          eq(servicePriceTiers.businessId, businessId),
          eq(servicePriceTiers.serviceTypeId, serviceTypeId),
          eq(servicePriceTiers.tier, params.tierEligibility),
          eq(servicePriceTiers.isActive, true),
        ),
      )
      .limit(1)
    if (tierRow) {
      return { amount: parseFloat(tierRow.amount), currency: tierRow.currency, tier: params.tierEligibility, source: 'tier' }
    }
  }

  // 2. Instance/series override
  if (params.instanceOverride != null) {
    return { amount: params.instanceOverride, currency, tier: null, source: 'instance' }
  }

  // 3. Service base price
  const [svc] = await db
    .select({ paymentAmount: serviceTypes.paymentAmount })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, businessId)))
    .limit(1)
  if (svc && svc.paymentAmount != null) {
    return { amount: parseFloat(svc.paymentAmount), currency, tier: null, source: 'service' }
  }

  // 4. None
  return { amount: null, currency, tier: null, source: 'none' }
}
