import { beforeEach, describe, expect, it, vi } from 'vitest'

const config = vi.hoisted(() => ({
  PROVIDER_MODE: 'real' as 'fake' | 'real',
  DEMO_HYBRID_MODE: true,
  PUBLIC_BASE_URL: 'http://localhost:3001',
  STRIPE_SECRET_KEY: 'sk_test_registry',
  STRIPE_MODE: 'TEST' as const,
  BAND_REST_URL: 'https://app.band.ai',
  BAND_AGENT_BRAIN: 'CODEX' as const,
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' as const,
  OPENROUTER_MODEL: 'openai/gpt-5.6-luna' as const,
  OPENROUTER_API_KEY: 'test-openrouter-key',
  DOCUMENSO_API_BASE_URL: 'https://app.documenso.com/api/v2',
  DOCUMENSO_CREATE_PATH: '/envelope/use',
  DOCUMENSO_RECONCILE_PATH: '/envelope?externalId={externalId}',
  DOCUMENSO_OWNER_RECIPIENT_ID: 'owner-recipient',
  DOCUMENSO_BUYER_RECIPIENT_ID: 'buyer-recipient',
  TERAC_TRANSPORT: 'http' as const,
  RENDER_API_KEY: 'configured',
  RENDER_WORKFLOW_SLUG: 'configured',
}))

vi.mock('../config.js', () => ({ getConfig: () => config }))

import {
  createProviderRegistry,
  createTeracContractReviewProvider,
  preflightProviders,
} from './registry.js'

beforeEach(() => {
  config.PROVIDER_MODE = 'real'
  config.DEMO_HYBRID_MODE = true
})

describe('hybrid provider registry', () => {
  it('uses non-live Terac and schema-compatible non-live Documenso proof', async () => {
    const registry = createProviderRegistry()
    const terac = registry.get('TERAC')
    const documenso = registry.get('DOCUMENSO')

    expect(terac?.capabilities().live).toBe(false)
    expect(documenso?.capabilities().live).toBe(false)
    await expect(documenso?.execute({
      demoRunId: 'demo-1',
      idempotencyKey: 'idem-1',
      payload: {
        owner: { name: 'Owner', identityRole: 'owner' },
        buyer: { name: 'Buyer', identityRole: 'buyer', consentedAt: '2026-08-15T10:00:00.000Z' },
      },
    })).resolves.toMatchObject({
      live: false,
      data: {
        envelopeId: 'mock_documenso_idem-1',
        externalId: 'idem-1',
        status: 'CREATED',
        templateId: 'mock-template-v1',
        signingOrder: ['owner', 'buyer'],
      },
    })
  })

  it('returns explicit non-live contract-review and Render preflight proof', async () => {
    const review = createTeracContractReviewProvider()

    expect(review.capabilities().live).toBe(false)
    await expect(review.execute({
      demoRunId: 'demo-1',
      idempotencyKey: 'idem-1',
      payload: { jurisdiction: 'Germany', contractText: 'Demo contract', question: 'Review it' },
    })).resolves.toMatchObject({
      live: false,
      data: {
        status: 'COMPLETE',
        taskId: 'mock_terac_contract_idem-1',
        issues: [{ clause: 'DEMO-ONLY' }],
      },
    })
    await expect(preflightProviders(new Map())).resolves.toEqual([
      { provider: 'TERAC_CONTRACT_REVIEW', live: false },
      { provider: 'RENDER', live: false },
    ])
  })

  it('keeps genuine real providers live by default', () => {
    config.DEMO_HYBRID_MODE = false
    const registry = createProviderRegistry()

    expect(registry.get('TERAC')?.capabilities().live).toBe(true)
    expect(registry.get('DOCUMENSO')?.capabilities().live).toBe(true)
    expect(createTeracContractReviewProvider().capabilities().live).toBe(true)
  })
})
