import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApprovalDecision, DemoRunStatus, OpportunityStage, PilotStatus, Provider, RunMode } from '@prisma/client'

const routeMocks = vi.hoisted(() => ({
  dispatchProviderAction: vi.fn(),
  findDemoRun: vi.fn(),
  getDemoRunSnapshot: vi.fn(),
  hybridMode: false,
  providerActionUpsert: vi.fn(),
  providerMode: 'fake',
  triggerRenderTask: vi.fn(),
  updatePilotActivation: vi.fn(),
}))

vi.mock('../auth.js', () => ({ requireOwner: vi.fn() }))
vi.mock('../config.js', () => ({
  getConfig: () => ({ PROVIDER_MODE: routeMocks.providerMode, DEMO_HYBRID_MODE: routeMocks.hybridMode }),
}))
vi.mock('../db.js', () => ({
  db: {
    demoRun: { findUniqueOrThrow: routeMocks.findDemoRun },
    pilotActivation: { update: routeMocks.updatePilotActivation },
    providerAction: { upsert: routeMocks.providerActionUpsert },
  },
}))
vi.mock('../domain/demo-service.js', () => ({
  appendRunEvent: vi.fn(),
  getDemoRunSnapshot: routeMocks.getDemoRunSnapshot,
  recordOwnerSignature: vi.fn(),
  transitionOpportunity: vi.fn(),
}))
vi.mock('../outbox.js', () => ({ dispatchProviderAction: routeMocks.dispatchProviderAction }))
vi.mock('../providers/registry.js', () => ({ createProviderRegistry: vi.fn(() => ({})) }))
vi.mock('../workflows/render-client.js', () => ({ triggerRenderTask: routeMocks.triggerRenderTask }))

import {
  assertManualTaskPhase,
  claimProviderEvent,
  classifyExistingProviderReceipt,
  inboundMessageBody,
  isDurablyDeliveredNegotiationProposal,
  manualTaskPhaseIsAllowed,
  providerEventCreateData,
  registerProviderRoutes,
  selectEligibleLinqOutbound,
} from './providers.js'

type RouteHandler = (
  request: { params: { id: string; slug: string } },
  reply: unknown,
) => Promise<unknown>

function registeredRoutes() {
  const routes = new Map<string, RouteHandler>()
  const app = {
    post(path: string, optionsOrHandler: unknown, maybeHandler?: unknown) {
      routes.set(path, (maybeHandler ?? optionsOrHandler) as RouteHandler)
    },
  }
  registerProviderRoutes(app as unknown as FastifyInstance)
  return routes
}

function eligibleRun(mode = RunMode.FAKE) {
  return {
    id: 'run-1',
    mode,
    status: DemoRunStatus.RUNNING,
    workspace: { pilotActivation: { id: 'pilot-1', status: PilotStatus.PAID } },
    approvals: [{ decision: ApprovalDecision.APPROVE }],
    opportunities: [
      { stage: OpportunityStage.RESEARCHING, company: { name: 'Nordlicht Import GmbH' } },
      { stage: OpportunityStage.RESEARCHING, company: { name: 'Maas Interiors BV' } },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  routeMocks.hybridMode = false
  routeMocks.providerMode = 'fake'
  routeMocks.findDemoRun.mockResolvedValue(eligibleRun())
  routeMocks.providerActionUpsert.mockResolvedValue({ id: 'provider-action-1' })
  routeMocks.dispatchProviderAction.mockResolvedValue({ data: { checkoutUrl: 'https://checkout.example.test/session' } })
  routeMocks.triggerRenderTask.mockResolvedValue('task-run-1')
  routeMocks.getDemoRunSnapshot.mockResolvedValue({ id: 'run-1' })
})

describe('provider route run-mode gates', () => {
  it('rejects Stripe activation for a FAKE run in real mode before provider dispatch', async () => {
    routeMocks.providerMode = 'real'
    routeMocks.findDemoRun.mockResolvedValueOnce({
      ...eligibleRun(),
      status: DemoRunStatus.AWAITING_PAYMENT,
      workspace: { pilotActivation: { id: 'pilot-secret', status: PilotStatus.PENDING } },
    })
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/activate')!

    await expect(handler({ params: { id: 'run-1', slug: '' } }, {})).rejects.toMatchObject({
      statusCode: 409,
      message: 'Real provider actions require a JUDGE run',
    })

    expect(routeMocks.providerActionUpsert).not.toHaveBeenCalled()
    expect(routeMocks.dispatchProviderAction).not.toHaveBeenCalled()
  })

  it('keeps FAKE Stripe activation supported in fake mode', async () => {
    routeMocks.findDemoRun.mockResolvedValueOnce({
      ...eligibleRun(),
      status: DemoRunStatus.AWAITING_PAYMENT,
      workspace: { pilotActivation: { id: 'pilot-1', status: PilotStatus.PENDING } },
    })
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/activate')!

    await expect(handler({ params: { id: 'run-1', slug: '' } }, {})).resolves.toEqual({
      checkoutUrl: 'https://checkout.example.test/session',
    })

    expect(routeMocks.dispatchProviderAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a manual task for a FAKE run in real mode before Render dispatch', async () => {
    routeMocks.providerMode = 'real'
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/tasks/:slug')!

    await expect(handler({ params: { id: 'run-1', slug: 'discover-research-leads' } }, {})).rejects.toMatchObject({
      statusCode: 409,
      message: 'Real provider actions require a JUDGE run',
    })

    expect(routeMocks.triggerRenderTask).not.toHaveBeenCalled()
  })

  it('keeps FAKE manual tasks supported in fake mode', async () => {
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/tasks/:slug')!

    await expect(handler({ params: { id: 'run-1', slug: 'discover-research-leads' } }, {})).resolves.toMatchObject({
      taskRunId: 'task-run-1',
    })

    expect(routeMocks.triggerRenderTask).toHaveBeenCalledWith('run-1', 'discover-research-leads')
  })

  it('keeps JUDGE manual tasks forbidden in ordinary fake mode', async () => {
    routeMocks.findDemoRun.mockResolvedValueOnce(eligibleRun(RunMode.JUDGE))
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/tasks/:slug')!

    await expect(handler({ params: { id: 'run-1', slug: 'discover-research-leads' } }, {})).rejects.toMatchObject({
      statusCode: 409,
      message: 'Fake provider actions require a FAKE run',
    })

    expect(routeMocks.triggerRenderTask).not.toHaveBeenCalled()
  })

  it('allows Stripe and manual Render actions for JUDGE runs in real mode', async () => {
    routeMocks.providerMode = 'real'
    routeMocks.findDemoRun
      .mockResolvedValueOnce({
        ...eligibleRun(RunMode.JUDGE),
        status: DemoRunStatus.AWAITING_PAYMENT,
        workspace: { pilotActivation: { id: 'pilot-1', status: PilotStatus.PENDING } },
      })
      .mockResolvedValueOnce(eligibleRun(RunMode.JUDGE))
    const routes = registeredRoutes()

    await routes.get('/api/v1/demo-runs/:id/activate')!({ params: { id: 'run-1', slug: '' } }, {})
    await routes.get('/api/v1/demo-runs/:id/tasks/:slug')!({ params: { id: 'run-1', slug: 'discover-research-leads' } }, {})

    expect(routeMocks.dispatchProviderAction).toHaveBeenCalledTimes(1)
    expect(routeMocks.triggerRenderTask).toHaveBeenCalledWith('run-1', 'discover-research-leads')
  })

  it('allows only FAKE provider actions and inline task dispatch in hybrid mode', async () => {
    routeMocks.hybridMode = true
    routeMocks.providerMode = 'real'
    routeMocks.findDemoRun
      .mockResolvedValueOnce({
        ...eligibleRun(),
        status: DemoRunStatus.AWAITING_PAYMENT,
        workspace: { pilotActivation: { id: 'pilot-1', status: PilotStatus.PENDING } },
      })
      .mockResolvedValueOnce(eligibleRun())
    const routes = registeredRoutes()

    await routes.get('/api/v1/demo-runs/:id/activate')!({ params: { id: 'run-1', slug: '' } }, {})
    await routes.get('/api/v1/demo-runs/:id/tasks/:slug')!({
      params: { id: 'run-1', slug: 'discover-research-leads' },
    }, {})

    expect(routeMocks.dispatchProviderAction).toHaveBeenCalledTimes(1)
    expect(routeMocks.triggerRenderTask).toHaveBeenCalledWith('run-1', 'discover-research-leads')
  })

  it('rejects JUDGE provider actions in hybrid mode before dispatch', async () => {
    routeMocks.hybridMode = true
    routeMocks.providerMode = 'real'
    routeMocks.findDemoRun.mockResolvedValue(eligibleRun(RunMode.JUDGE))
    const routes = registeredRoutes()

    await expect(routes.get('/api/v1/demo-runs/:id/tasks/:slug')!({
      params: { id: 'run-1', slug: 'discover-research-leads' },
    }, {})).rejects.toMatchObject({
      statusCode: 409,
      message: 'Hybrid provider actions require a FAKE run',
    })

    expect(routeMocks.triggerRenderTask).not.toHaveBeenCalled()
  })
})

describe('manual workflow task phase guard', () => {
  const paidRunning = {
    runStatus: DemoRunStatus.RUNNING,
    pilotStatus: PilotStatus.PAID,
    campaignApproved: true,
    opportunityStages: {
      'Nordlicht Import GmbH': OpportunityStage.RESEARCHING,
      'Maas Interiors BV': OpportunityStage.RESEARCHING,
    },
  }

  it.each([
    ['run-terac-campaign-study', { ...paidRunning, runStatus: DemoRunStatus.STUDY_RUNNING, campaignApproved: false }],
    ['discover-research-leads', paidRunning],
    ['send-nordlicht-outreach', paidRunning],
    ['run-band-negotiation', { ...paidRunning, opportunityStages: { ...paidRunning.opportunityStages, 'Nordlicht Import GmbH': OpportunityStage.ENGAGED } }],
    ['review-contract-and-create-envelope', { ...paidRunning, opportunityStages: { ...paidRunning.opportunityStages, 'Nordlicht Import GmbH': OpportunityStage.AGREEMENT } }],
    ['prove-render-retry', paidRunning],
  ] as const)('allows %s only at its normal workflow entry phase', (slug, phase) => {
    expect(manualTaskPhaseIsAllowed(slug, phase)).toBe(true)
  })

  it.each([
    ['run-terac-campaign-study', 'payment has not advanced the run', { ...paidRunning, runStatus: DemoRunStatus.AWAITING_PAYMENT, campaignApproved: false }],
    ['run-terac-campaign-study', 'study phase already passed', { ...paidRunning, runStatus: DemoRunStatus.AWAITING_CAMPAIGN_APPROVAL, campaignApproved: false }],
    ['discover-research-leads', 'campaign is not approved', { ...paidRunning, campaignApproved: false }],
    ['send-nordlicht-outreach', 'outreach already started', { ...paidRunning, opportunityStages: { ...paidRunning.opportunityStages, 'Nordlicht Import GmbH': OpportunityStage.OUTREACH } }],
    ['run-band-negotiation', 'buyer has not engaged', paidRunning],
    ['run-band-negotiation', 'negotiation already started', { ...paidRunning, opportunityStages: { ...paidRunning.opportunityStages, 'Nordlicht Import GmbH': OpportunityStage.NEGOTIATING } }],
    ['review-contract-and-create-envelope', 'buyer has not accepted', { ...paidRunning, opportunityStages: { ...paidRunning.opportunityStages, 'Nordlicht Import GmbH': OpportunityStage.NEGOTIATING } }],
    ['review-contract-and-create-envelope', 'signing already started', { ...paidRunning, opportunityStages: { ...paidRunning.opportunityStages, 'Nordlicht Import GmbH': OpportunityStage.SIGNING } }],
    ['prove-render-retry', 'pilot is unpaid', { ...paidRunning, pilotStatus: PilotStatus.PENDING }],
    ['prove-render-retry', 'run is terminal', { ...paidRunning, runStatus: DemoRunStatus.COMPLETE }],
  ] as const)('rejects %s when %s', (slug, _reason, phase) => {
    expect(() => assertManualTaskPhase(slug, phase)).toThrow(
      expect.objectContaining({
        statusCode: 409,
        message: 'Workflow task is not available in the current run phase',
      }),
    )
  })
})

describe('Linq inbound target selection', () => {
  const candidate = (overrides: {
    id: string
    demoRunId: string
    opportunityId: string
    occurredAt: string
    runStatus?: DemoRunStatus
    stage?: OpportunityStage
  }) => ({
    id: overrides.id,
    demoRunId: overrides.demoRunId,
    opportunityId: overrides.opportunityId,
    live: true,
    occurredAt: new Date(overrides.occurredAt),
    opportunity: {
      stage: overrides.stage ?? OpportunityStage.OUTREACH,
      demoRun: { status: overrides.runStatus ?? DemoRunStatus.RUNNING },
      company: { name: 'Nordlicht Import GmbH' },
      contact: { consented: true, rolePlayer: true, addressHash: 'sender-fingerprint' },
    },
  })

  it('fails closed when an old run shares the same role-player thread', () => {
    const oldCompleted = candidate({
      id: 'old-message',
      demoRunId: 'old-run',
      opportunityId: 'old-opportunity',
      occurredAt: '2026-08-15T11:00:00.000Z',
      runStatus: DemoRunStatus.COMPLETE,
      stage: OpportunityStage.SIGNED,
    })
    const current = candidate({
      id: 'current-message',
      demoRunId: 'current-run',
      opportunityId: 'current-opportunity',
      occurredAt: '2026-08-15T10:00:00.000Z',
    })

    expect(selectEligibleLinqOutbound([oldCompleted, current], 'sender-fingerprint')).toEqual({ status: 'AMBIGUOUS' })
  })

  it('fails closed when two runs are concurrently eligible on the shared thread', () => {
    const first = candidate({ id: 'message-1', demoRunId: 'run-1', opportunityId: 'opportunity-1', occurredAt: '2026-08-15T10:00:00.000Z' })
    const second = candidate({ id: 'message-2', demoRunId: 'run-2', opportunityId: 'opportunity-2', occurredAt: '2026-08-15T11:00:00.000Z' })

    expect(selectEligibleLinqOutbound([second, first], 'sender-fingerprint')).toEqual({ status: 'AMBIGUOUS' })
  })

  it('deduplicates repeated outbound messages for the same run and opportunity', () => {
    const first = candidate({ id: 'message-1', demoRunId: 'run-1', opportunityId: 'opportunity-1', occurredAt: '2026-08-15T10:00:00.000Z' })
    const latest = candidate({ id: 'message-2', demoRunId: 'run-1', opportunityId: 'opportunity-1', occurredAt: '2026-08-15T11:00:00.000Z' })

    expect(selectEligibleLinqOutbound([first, latest], 'sender-fingerprint')).toEqual({ status: 'MATCHED', outbound: latest })
  })
})

describe('provider receipt replay classification', () => {
  const incoming = { payloadHash: 'hash_1', demoRunId: 'run_1', eventType: 'message.received' }

  it('resumes an identical receipt whose effects were not marked processed', () => {
    expect(classifyExistingProviderReceipt({ ...incoming, processedAt: null }, incoming)).toBe('RESUME')
  })

  it('does not repeat effects for an identical processed receipt', () => {
    expect(classifyExistingProviderReceipt({ ...incoming, processedAt: new Date() }, incoming)).toBe('DONE')
  })

  it.each([
    { ...incoming, payloadHash: 'different' },
    { ...incoming, demoRunId: 'run_2' },
    { ...incoming, eventType: 'message.sent' },
  ])('rejects reuse of an event id for a different payload or target', (mismatch) => {
    expect(() => classifyExistingProviderReceipt({ ...mismatch, processedAt: null }, incoming)).toThrow('reused')
  })
})

describe('provider receipt creation', () => {
  it('hashes the raw payload without including it in Prisma create data', () => {
    const data = providerEventCreateData({
      demoRunId: 'run_1',
      provider: Provider.DOCUMENSO,
      externalEventId: 'event_1',
      eventType: 'DOCUMENT_COMPLETED',
      raw: '{"secret":"must-not-be-stored"}',
    })

    expect(data).toEqual({
      demoRunId: 'run_1',
      provider: Provider.DOCUMENSO,
      externalEventId: 'event_1',
      eventType: 'DOCUMENT_COMPLETED',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(data).not.toHaveProperty('raw')
  })

  it('grants exactly one lease when identical deliveries arrive concurrently', async () => {
    const input = {
      demoRunId: 'run_1',
      provider: Provider.LINQ,
      externalEventId: 'event_1',
      eventType: 'message.received',
      raw: '{"event":"same"}',
    }
    type StoredReceipt = ReturnType<typeof providerEventCreateData> & {
      id: string
      processedAt: Date | null
      processingToken: string | null
      processingExpiresAt: Date | null
    }
    let receipt: StoredReceipt | null = null
    const store = {
      async create({ data }: { data: Record<string, unknown> }) {
        if (receipt) throw Object.assign(new Error('unique'), { code: 'P2002' })
        receipt = {
          ...providerEventCreateData(input),
          id: 'receipt_1',
          processedAt: null,
          processingToken: String(data.processingToken),
          processingExpiresAt: data.processingExpiresAt as Date,
        }
        return receipt
      },
      async findUniqueOrThrow() {
        if (!receipt) throw new Error('missing')
        return receipt
      },
      async findUnique() {
        return receipt
      },
      async updateMany() {
        return { count: 0 }
      },
    }

    const [first, second] = await Promise.all([
      claimProviderEvent(input, { store, now: new Date('2026-08-15T10:00:00.000Z'), leaseToken: 'lease-a' }),
      claimProviderEvent(input, { store, now: new Date('2026-08-15T10:00:00.000Z'), leaseToken: 'lease-b' }),
    ])

    expect([first.status, second.status].sort()).toEqual(['BUSY', 'NEW'])
    expect([first, second].filter((claim) => 'leaseToken' in claim)).toHaveLength(1)
  })
})

describe('role-player evidence sanitization', () => {
  it.each([
    ['phone', 'Call me at +49 30 12345678 to discuss delivery.', '+49 30 12345678'],
    ['address', 'Ship to 17 Hafenstrasse, 20457 Hamburg, Germany.', '17 Hafenstrasse'],
    ['account number', 'Use account IBAN DE89 3704 0044 0532 0130 00.', 'DE89 3704'],
    ['token', 'token=linq_live_super_secret and password: hunter2', 'linq_live_super_secret'],
  ])('withholds uncontrolled free text containing a %s', (_fixture, text, sensitiveValue) => {
    const body = inboundMessageBody({
      optedOut: false,
      companyName: 'Nordlicht Import GmbH',
      text,
    })

    expect(body).toBe('Consenting Nordlicht role-player replied; free text withheld.')
    expect(body).not.toContain(sensitiveValue)
  })

  it('preserves only explicit acceptance and a verified EUR price', () => {
    expect(inboundMessageBody({
      optedOut: false,
      companyName: 'Nordlicht Import GmbH',
      text: 'We accept the terms.',
    })).toBe('Consenting Nordlicht role-player explicitly accepted.')

    expect(inboundMessageBody({
      optedOut: false,
      companyName: 'Maas Interiors BV',
      text: 'EUR 172/seat. Email buyer@example.com, visit https://example.com/deal, or call +49 30 12345678.',
    })).toBe('Consenting Maas role-player stated EUR 172/seat.')
  })

  it('records opt-out as a fixed fact without retaining the accompanying text', () => {
    expect(inboundMessageBody({
      optedOut: true,
      companyName: 'Nordlicht Import GmbH',
      text: 'Stop messaging me; token=linq_live_super_secret',
    })).toBe('Role-player opted out.')
  })
})

describe('explicit buyer acceptance gate', () => {
  const expected = { demoRunId: 'run_1', opportunityId: 'opp_1' }
  const action = {
    demoRunId: 'run_1',
    provider: Provider.LINQ,
    kind: 'message.send',
    idempotencyKey: 'linq-negotiation-proposal:run_1:opp_1:172',
    status: 'SUCCEEDED',
    live: true,
    providerExternalId: 'linq:proposal_1',
  }
  const message = {
    demoRunId: 'run_1',
    opportunityId: 'opp_1',
    direction: 'OUTBOUND',
    live: true,
    externalId: 'linq:proposal_1',
  }

  it('accepts only an exact live, succeeded action joined to its persisted outbound message', () => {
    expect(isDurablyDeliveredNegotiationProposal({ action, message }, expected)).toBe(true)
  })

  it.each([
    [{ ...action, status: 'RUNNING' }, message],
    [{ ...action, live: false }, message],
    [{ ...action, idempotencyKey: 'linq-outreach:run_1:opp_1' }, message],
    [action, { ...message, externalId: 'linq:other' }],
    [action, null],
  ])('rejects incomplete or mismatched delivery evidence', (candidateAction, candidateMessage) => {
    expect(isDurablyDeliveredNegotiationProposal({ action: candidateAction, message: candidateMessage }, expected)).toBe(false)
  })
})
