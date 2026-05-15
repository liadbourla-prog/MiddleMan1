import { google } from 'googleapis'
import { z } from 'zod'

const GMB_SCOPE = 'https://www.googleapis.com/auth/business.manage'
const GMB_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const GMB_VERIFICATIONS_BASE = 'https://mybusinessverifications.googleapis.com/v1'

export interface CreateLocationParams {
  businessName: string
  categoryId: string
  phone: string
  address: { streetAddress: string; city: string; country: string }
  websiteUrl: string | null
  description: string
  serviceArea: string[]
}

export interface VerificationOption {
  method: 'POSTCARD' | 'PHONE_CALL'
  displayName: string
}

export interface GmbClient {
  listAccounts(): Promise<{ accountId: string; name: string }[]>
  createLocation(accountId: string, params: CreateLocationParams): Promise<{ locationId: string; profileUrl: string }>
  updateLocation(locationId: string, params: Partial<CreateLocationParams>): Promise<void>
  getVerificationOptions(locationId: string): Promise<VerificationOption[]>
  requestVerification(locationId: string, method: 'POSTCARD' | 'PHONE_CALL'): Promise<void>
}

const AccountSchema = z.object({
  name: z.string(),
  accountName: z.string().optional(),
  displayName: z.string().optional(),
})
const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema).optional(),
})

const LocationSchema = z.object({
  name: z.string(),
  metadata: z.object({
    mapsUrl: z.string().optional(),
    newReviewUrl: z.string().optional(),
  }).optional(),
})

const VerificationOptionSchema = z.object({
  verificationMethod: z.enum(['POSTCARD', 'PHONE_CALL', 'EMAIL', 'VETTED_PARTNER', 'AUTO']),
  displayName: z.string().optional(),
})
const VerificationOptionsResponseSchema = z.object({
  options: z.array(VerificationOptionSchema).optional(),
})

function buildOAuth2Client(gmbRefreshToken: string) {
  const client = new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
  )
  client.setCredentials({ refresh_token: gmbRefreshToken, scope: GMB_SCOPE })
  return client
}

async function gmbFetch(
  auth: ReturnType<typeof buildOAuth2Client>,
  url: string,
  options: RequestInit = {},
): Promise<unknown> {
  const { token } = await auth.getAccessToken()
  if (!token) throw new Error('Failed to obtain GMB access token')

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    },
  })

  const text = await res.text()
  if (!res.ok) {
    throw Object.assign(new Error(`GMB API error ${res.status}: ${text}`), { status: res.status, body: text })
  }
  if (!text) return {}
  return JSON.parse(text)
}

export function createGmbClient(gmbRefreshToken: string): GmbClient {
  const auth = buildOAuth2Client(gmbRefreshToken)

  return {
    async listAccounts() {
      const raw = await gmbFetch(auth, `https://mybusinessaccountmanagement.googleapis.com/v1/accounts`)
      const parsed = AccountsResponseSchema.parse(raw)
      return (parsed.accounts ?? []).map((a) => ({
        accountId: a.name,
        name: a.displayName ?? a.accountName ?? a.name,
      }))
    },

    async createLocation(accountId: string, params: CreateLocationParams) {
      const body = {
        title: params.businessName,
        categories: { primaryCategory: { name: `categories/${params.categoryId}` } },
        phoneNumbers: { primaryPhone: params.phone },
        storefrontAddress: {
          addressLines: [params.address.streetAddress],
          locality: params.address.city,
          regionCode: params.address.country,
        },
        ...(params.websiteUrl ? { websiteUri: params.websiteUrl } : {}),
        profile: { description: params.description },
        serviceArea: params.serviceArea.length > 0 ? {
          businessType: 'CUSTOMER_LOCATION_ONLY',
          places: { placeInfos: params.serviceArea.map((r) => ({ placeName: r })) },
        } : undefined,
      }
      const raw = await gmbFetch(auth, `${GMB_BASE}/${accountId}/locations?validateOnly=false`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      const parsed = LocationSchema.parse(raw)
      const profileUrl = parsed.metadata?.mapsUrl ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(params.businessName)}`
      return { locationId: parsed.name, profileUrl }
    },

    async updateLocation(locationId: string, params: Partial<CreateLocationParams>) {
      const body: Record<string, unknown> = {}
      if (params.businessName) body['title'] = params.businessName
      if (params.description) body['profile'] = { description: params.description }
      if (params.websiteUrl !== undefined) body['websiteUri'] = params.websiteUrl
      if (params.phone) body['phoneNumbers'] = { primaryPhone: params.phone }

      const updateMask = Object.keys(body).join(',')
      await gmbFetch(auth, `${GMB_BASE}/${locationId}?updateMask=${updateMask}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
    },

    async getVerificationOptions(locationId: string) {
      const raw = await gmbFetch(
        auth,
        `${GMB_VERIFICATIONS_BASE}/${locationId}/verificationOptions`,
      )
      const parsed = VerificationOptionsResponseSchema.parse(raw)
      const supported = new Set<string>(['POSTCARD', 'PHONE_CALL'])
      return (parsed.options ?? [])
        .filter((o) => supported.has(o.verificationMethod))
        .map((o) => ({
          method: o.verificationMethod as 'POSTCARD' | 'PHONE_CALL',
          displayName: o.displayName ?? o.verificationMethod,
        }))
    },

    async requestVerification(locationId: string, method: 'POSTCARD' | 'PHONE_CALL') {
      await gmbFetch(auth, `${GMB_VERIFICATIONS_BASE}/${locationId}:verify`, {
        method: 'POST',
        body: JSON.stringify({ method }),
      })
    },
  }
}
