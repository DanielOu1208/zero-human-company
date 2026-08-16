import { DemoRunStatus, Provider, RevisionStatus } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const db = {
    demoRun: { findUniqueOrThrow: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    providerAction: { upsert: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn() },
    humanStudy: { findUnique: vi.fn(), upsert: vi.fn() },
    campaignRevision: { updateMany: vi.fn() },
    event: { findFirst: vi.fn() },
    opportunity: { findFirstOrThrow: vi.fn() },
    message: { upsert: vi.fn() },
    providerEvent: { findUnique: vi.fn() },
    document: { upsert: vi.fn(), update: vi.fn() },
    approval: { upsert: vi.fn() },
    $transaction: vi.fn(),
  }
  return {
    db,
    dispatchProviderAction: vi.fn(),
    appendRunEvent: vi.fn(),
    recordOwnerSignature: vi.fn(),
    transitionOpportunity: vi.fn(),
    createTeracContractReviewProvider: vi.fn(),
    config: {
      DEMO_HYBRID_MODE: false,
      PROVIDER_MODE: 'real',
      REAL_ACTIONS_ENABLED: true,
      DOCUMENSO_BUYER_EMAIL: 'anja@nordlicht.example' as string | undefined,
      LINQ_NORDLICHT_RECIPIENT: 'anja@nordlicht.example',
    },
  }
})

vi.mock('../db.js', () => ({ db: mocks.db }))
vi.mock('../outbox.js', () => ({ dispatchProviderAction: mocks.dispatchProviderAction }))
vi.mock('../config.js', () => ({
  getConfig: () => mocks.config,
}))
vi.mock('../providers/registry.js', () => ({
  createTeracContractReviewProvider: mocks.createTeracContractReviewProvider,
}))
vi.mock('../domain/demo-service.js', () => ({
  appendRunEvent: mocks.appendRunEvent,
  recordOwnerSignature: mocks.recordOwnerSignature,
  transitionOpportunity: mocks.transitionOpportunity,
}))

import {
  assertLinqRecipientEligible,
  assertTeracStudyBoundToRevisions,
  bandRequestFromInbound,
  consentedLinqRequest,
  contractDocumentCreatedEvent,
  documensoBuyerFromLinqAcceptance,
  documensoEnvelopeRequest,
  evaluateBandVerdict,
  mockDocumentEvidenceTimestamps,
  recipientFingerprint,
  restartNordlichtOutreach,
  reviewContractAndCreateEnvelope,
  resolveMonidCompanyMatch,
  runTeracCampaignStudy,
  teracStudyCompletionEvent,
} from './tasks.js'

describe('hybrid Nordlicht outreach restart', () => {
  const restartAction = {
    id: 'restart-action-1',
    idempotencyKey: 'linq-outreach-restart:run-1:opp-1:7',
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.config.DEMO_HYBRID_MODE = true
    mocks.config.PROVIDER_MODE = 'real'
    mocks.config.REAL_ACTIONS_ENABLED = true
    mocks.db.opportunity.findFirstOrThrow.mockResolvedValue({
      id: 'opp-1',
      stage: 'PAUSED',
      stageReason: 'BAND_ESCALATE',
      version: 7,
      company,
      contact: { ...contact, addressHash: recipientFingerprint('anja@nordlicht.example') },
      demoRun: { mode: 'FAKE', status: 'RUNNING' },
    })
    mocks.db.providerAction.findFirst.mockResolvedValue(null)
    mocks.db.providerAction.findUniqueOrThrow.mockResolvedValue(restartAction)
    mocks.db.event.findFirst.mockResolvedValue(null)
    mocks.dispatchProviderAction.mockResolvedValue({
      provider: Provider.LINQ,
      externalId: 'linq-restart-message',
      live: true,
      status: 'ACCEPTED',
      data: { messageId: 'linq-restart-message', chatId: 'linq-chat-1', service: 'iMessage' },
      redacted: {},
    })
  })

  it('atomically resumes the pause and creates a new idempotent first outreach', async () => {
    await restartNordlichtOutreach('run-1', new Map())

    expect(mocks.transitionOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      opportunityId: 'opp-1',
      to: 'ENGAGED',
      eventType: 'outreach.restarted',
      action: expect.objectContaining({
        provider: Provider.LINQ,
        kind: 'message.send',
        idempotencyKey: restartAction.idempotencyKey,
        request: { recipient: { consented: true, rolePlayerId: 'nordlicht' }, template: 'OUTREACH_V1', args: {} },
      }),
    }))
    expect(mocks.dispatchProviderAction).toHaveBeenCalledWith('restart-action-1', expect.any(Map))
    expect(mocks.db.message.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ externalId: 'linq-restart-message', threadExternalId: 'linq-chat-1', live: true }),
    }))
    expect(mocks.appendRunEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'message.sent',
      proofRef: 'linq-restart-message',
    }))
  })

  it('reuses the durable restart action after an interrupted request', async () => {
    mocks.db.opportunity.findFirstOrThrow.mockResolvedValueOnce({
      id: 'opp-1',
      stage: 'ENGAGED',
      stageReason: null,
      version: 8,
      company,
      contact: { ...contact, addressHash: recipientFingerprint('anja@nordlicht.example') },
      demoRun: { mode: 'FAKE', status: 'RUNNING' },
    })
    mocks.db.providerAction.findFirst.mockResolvedValueOnce({ ...restartAction, status: 'SUCCEEDED' })

    await restartNordlichtOutreach('run-1', new Map())

    expect(mocks.transitionOpportunity).not.toHaveBeenCalled()
    expect(mocks.db.providerAction.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(mocks.dispatchProviderAction).toHaveBeenCalledWith('restart-action-1', expect.any(Map))
  })

  it('replays a completed response safely after the opportunity advances', async () => {
    mocks.db.opportunity.findFirstOrThrow.mockResolvedValueOnce({
      id: 'opp-1',
      stage: 'NEGOTIATING',
      stageReason: null,
      version: 9,
      company,
      contact: { ...contact, addressHash: recipientFingerprint('anja@nordlicht.example') },
      demoRun: { mode: 'FAKE', status: 'COMPLETE' },
    })
    mocks.db.providerAction.findFirst.mockResolvedValueOnce({ ...restartAction, status: 'SUCCEEDED' })
    mocks.dispatchProviderAction.mockResolvedValueOnce({
      provider: Provider.LINQ,
      externalId: 'linq-restart-message',
      live: true,
      status: 'COMPLETE',
      data: { messageId: 'linq-restart-message', chatId: 'linq-chat-1', service: 'iMessage' },
      redacted: {},
    })

    await expect(restartNordlichtOutreach('run-1', new Map())).resolves.toBeUndefined()
    expect(mocks.transitionOpportunity).not.toHaveBeenCalled()
    expect(mocks.dispatchProviderAction).toHaveBeenCalledTimes(1)
  })

  it('fails closed when Linq does not return live accepted message and chat proof', async () => {
    mocks.dispatchProviderAction.mockResolvedValueOnce({
      provider: Provider.LINQ,
      externalId: 'linq-restart-message',
      live: true,
      status: 'ACCEPTED',
      data: { messageId: 'linq-restart-message' },
      redacted: {},
    })

    await expect(restartNordlichtOutreach('run-1', new Map())).rejects.toThrow(/invalid restart acceptance proof/)
    expect(mocks.db.message.upsert).not.toHaveBeenCalled()
    expect(mocks.appendRunEvent).not.toHaveBeenCalled()
  })
})

const company = {
  name: 'Nordlicht Import GmbH',
  researchOnly: false,
  monidProviderId: null,
}

const address = '+15551234567'
const contact = {
  consented: true,
  rolePlayer: true,
  addressHash: recipientFingerprint(address),
}

const verdict = {
  recommendation: 'COUNTER' as const,
  proposedPrice: 172,
  risks: ['Buyer acceptance remains outstanding'],
  rationale: 'The proposal is within policy.',
  agentVotes: [
    { agentId: 'policy', vote: 'COUNTER' as const, rationale: 'Meets the floor.' },
  ],
}

describe('Linq workflow consent gate', () => {
  it('allows only a matching consent fingerprint on a non-research company', () => {
    expect(() => assertLinqRecipientEligible(company, contact, address)).not.toThrow()
    expect(() => assertLinqRecipientEligible(company, contact, '+15557654321')).toThrow(/consent fingerprint/)
    expect(() => assertLinqRecipientEligible({ ...company, researchOnly: true }, contact, address)).toThrow(/research-only/)
    expect(() => assertLinqRecipientEligible({ ...company, monidProviderId: 'monid-1' }, contact, address)).toThrow(/Monid-discovered/)
  })

  it('serializes planned requests with only the consented role-player id and versioned safe intent', () => {
    const request = consentedLinqRequest('nordlicht', 'NEGOTIATION_PROPOSAL_V1', { proposalPrice: 172 })
    const serialized = JSON.stringify(request)

    expect(request).toEqual({
      recipient: { consented: true, rolePlayerId: 'nordlicht' },
      template: 'NEGOTIATION_PROPOSAL_V1',
      args: { proposalPrice: 172 },
    })
    expect(serialized).not.toContain(address)
    expect(serialized).not.toMatch(/address|email|Proposed commercial terms/i)
  })
})

describe('Terac workflow proof binding', () => {
  const expectedIds = ['candidate-a', 'candidate-b'] as const
  const completeStudy = {
    scores: [{ candidateId: 'candidate-a' }, { candidateId: 'candidate-b' }],
    baselineScores: { candidateId: 'baseline' },
  }

  it('accepts the exact submitted baseline and candidate revision ids', () => {
    expect(() => assertTeracStudyBoundToRevisions(completeStudy, 'baseline', expectedIds)).not.toThrow()
  })

  it('rejects missing, unrelated, or duplicate candidate revision ids', () => {
    const unrelated = { ...completeStudy, scores: [{ candidateId: 'candidate-a' }, { candidateId: 'unrelated' }] }
    const duplicate = { ...completeStudy, scores: [{ candidateId: 'candidate-a' }, { candidateId: 'candidate-a' }] }

    expect(() => assertTeracStudyBoundToRevisions(unrelated, 'baseline', expectedIds)).toThrow(/exactly match/)
    expect(() => assertTeracStudyBoundToRevisions(duplicate, 'baseline', expectedIds)).toThrow(/exactly match/)
  })

  it('rejects missing or unrelated baseline revision ids', () => {
    expect(() => assertTeracStudyBoundToRevisions(
      { ...completeStudy, baselineScores: { candidateId: 'unrelated' } },
      'baseline',
      expectedIds,
    )).toThrow(/baseline/)
    expect(() => assertTeracStudyBoundToRevisions(
      { scores: completeStudy.scores },
      'baseline',
      expectedIds,
    )).toThrow(/baseline/)
  })
})

describe('hybrid workflow timeline truthfulness', () => {
  it('attributes a live campaign study to Terac', () => {
    expect(teracStudyCompletionEvent(true, 'Candidate B', 31)).toEqual({
      summary: 'Terac selected Candidate B with a 31.00-point average lift.',
      actor: 'terac',
    })
  })

  it('labels a mock campaign route without claiming human Terac respondents', () => {
    const event = teracStudyCompletionEvent(false, 'Candidate B', 31)

    expect(event).toEqual({
      summary: 'Mock demo route selected Candidate B with a 31.00-point average lift; no human Terac study was run.',
      actor: 'mock-demo',
    })
    expect(event.summary).not.toMatch(/Terac selected|human respondents/i)
  })

  it('uses provider attribution only when contract review and envelope creation are live', () => {
    expect(contractDocumentCreatedEvent(true, true)).toEqual({
      summary: 'Terac contract review completed for German-law clauses; Documenso started owner-first sequential signing.',
      actor: 'documenso',
    })
  })

  it.each([
    [false, true],
    [true, false],
    [false, false],
  ])('labels contract and document presentation as mock when review=%s and envelope=%s', (reviewLive, envelopeLive) => {
    const event = contractDocumentCreatedEvent(reviewLive, envelopeLive)

    expect(event).toEqual({
      summary: 'Mock, non-legal contract review completed; mock Documenso demo started owner-first sequential signing.',
      actor: 'mock-demo',
    })
    expect(event.summary).not.toMatch(/German counsel/i)
  })

  it('derives stable owner-first and buyer-second mock timestamps from acceptance', () => {
    const evidence = mockDocumentEvidenceTimestamps(new Date('2026-08-15T10:00:00.000Z'))

    expect(evidence).toEqual({
      ownerSignedAt: new Date('2026-08-15T10:00:01.000Z'),
      buyerSignedAt: new Date('2026-08-15T10:00:02.000Z'),
      completedAt: new Date('2026-08-15T10:00:02.000Z'),
    })
    expect(evidence.ownerSignedAt.getTime()).toBeLessThan(evidence.buyerSignedAt.getTime())
  })
})

describe('hybrid contract completion', () => {
  const acceptanceTime = new Date('2026-08-15T10:00:00.000Z')
  const opportunity = {
    id: 'opp-nordlicht',
    stage: 'AGREEMENT',
    company,
    contact: { ...contact, name: 'Anja Keller', addressHash: recipientFingerprint('anja@nordlicht.example') },
  }
  const acceptance = {
    demoRunId: 'run-1',
    opportunityId: opportunity.id,
    type: 'agreement.accepted',
    actor: 'linq',
    proofRef: 'linq-acceptance-1',
    occurredAt: acceptanceTime,
  }
  const receipt = {
    demoRunId: 'run-1',
    provider: Provider.LINQ,
    externalEventId: 'linq-acceptance-1',
    eventType: 'message.received',
    processedAt: new Date('2026-08-15T10:00:00.500Z'),
  }
  const reviewProvider = { provider: Provider.TERAC }

  function providerResult(provider: Provider, externalId: string, live: boolean, data: Record<string, unknown>) {
    return { provider, externalId, live, status: 'COMPLETED', data, redacted: {} }
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.config.DEMO_HYBRID_MODE = false
    mocks.config.DOCUMENSO_BUYER_EMAIL = 'anja@nordlicht.example'
    mocks.createTeracContractReviewProvider.mockReturnValue(reviewProvider)
    mocks.db.opportunity.findFirstOrThrow.mockResolvedValue(opportunity)
    mocks.db.event.findFirst.mockResolvedValueOnce(acceptance).mockResolvedValue(null)
    mocks.db.providerEvent.findUnique.mockResolvedValue(receipt)
    mocks.db.providerAction.upsert
      .mockResolvedValueOnce({ id: 'review-action' })
      .mockResolvedValueOnce({ id: 'envelope-action' })
    mocks.db.document.upsert.mockResolvedValue({ id: 'document-1' })
  })

  it('completes a mock envelope with ordered simulated evidence and explicit demo events', async () => {
    mocks.config.DEMO_HYBRID_MODE = true
    mocks.config.DOCUMENSO_BUYER_EMAIL = undefined
    mocks.db.providerEvent.findUnique.mockResolvedValue({
      ...receipt,
      processedAt: null,
      processingToken: 'linq-processing-lease',
    })
    mocks.dispatchProviderAction
      .mockResolvedValueOnce(providerResult(Provider.TERAC, 'terac:mock-review', false, { status: 'COMPLETE' }))
      .mockResolvedValueOnce(providerResult(Provider.DOCUMENSO, 'documenso:mock-envelope', false, {
        envelopeId: 'mock-envelope',
        status: 'CREATED',
      }))

    await reviewContractAndCreateEnvelope('run-1', new Map())

    expect(mocks.recordOwnerSignature).toHaveBeenCalledWith('run-1')
    expect(mocks.db.document.update).toHaveBeenCalledWith({
      where: { provider_externalId: { provider: Provider.DOCUMENSO, externalId: 'mock-envelope' } },
      data: {
        ownerSignedAt: new Date('2026-08-15T10:00:01.000Z'),
        buyerSignedAt: new Date('2026-08-15T10:00:02.000Z'),
        completedAt: new Date('2026-08-15T10:00:02.000Z'),
        status: 'COMPLETED',
      },
    })
    expect(mocks.transitionOpportunity).toHaveBeenNthCalledWith(1, expect.objectContaining({
      to: 'SIGNING',
      summary: expect.stringMatching(/Mock, non-legal.*mock Documenso/i),
      actor: 'mock-demo',
    }))
    expect(mocks.transitionOpportunity).toHaveBeenNthCalledWith(2, expect.objectContaining({
      to: 'SIGNED',
      summary: expect.stringMatching(/MOCK\/DEMO.*no real signatures or legal review/i),
      actor: 'mock-demo',
    }))
    expect(mocks.db.demoRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: DemoRunStatus.COMPLETE, completedAt: new Date('2026-08-15T10:00:02.000Z') },
    })
    expect(mocks.appendRunEvent).toHaveBeenCalledTimes(2)
    expect(mocks.appendRunEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'owner.signed',
      summary: expect.stringMatching(/MOCK\/DEMO.*no real signature/i),
      actor: 'mock-demo',
    }))
    expect(mocks.appendRunEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'demo.completed',
      summary: expect.stringMatching(/MOCK\/DEMO signing simulation/i),
      actor: 'mock-demo',
    }))
  })

  it('keeps a fully live envelope awaiting the real owner signature', async () => {
    mocks.dispatchProviderAction
      .mockResolvedValueOnce(providerResult(Provider.TERAC, 'terac:live-review', true, { status: 'COMPLETE' }))
      .mockResolvedValueOnce(providerResult(Provider.DOCUMENSO, 'documenso:live-envelope', true, {
        envelopeId: 'live-envelope',
        status: 'CREATED',
      }))

    await reviewContractAndCreateEnvelope('run-1', new Map())

    expect(mocks.transitionOpportunity).toHaveBeenCalledOnce()
    expect(mocks.transitionOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      to: 'SIGNING',
      summary: expect.stringMatching(/Terac contract review.*Documenso started/i),
      actor: 'documenso',
    }))
    expect(mocks.recordOwnerSignature).not.toHaveBeenCalled()
    expect(mocks.db.document.update).not.toHaveBeenCalled()
    expect(mocks.db.demoRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: DemoRunStatus.AWAITING_OWNER_SIGNATURE },
    })
  })

  it('does not auto-sign non-live results outside explicit hybrid mode', async () => {
    mocks.dispatchProviderAction
      .mockResolvedValueOnce(providerResult(Provider.TERAC, 'terac:mock-review', false, { status: 'COMPLETE' }))
      .mockResolvedValueOnce(providerResult(Provider.DOCUMENSO, 'documenso:mock-envelope', false, {
        envelopeId: 'mock-envelope',
        status: 'CREATED',
      }))

    await reviewContractAndCreateEnvelope('run-1', new Map())

    expect(mocks.recordOwnerSignature).not.toHaveBeenCalled()
    expect(mocks.db.document.update).not.toHaveBeenCalled()
    expect(mocks.transitionOpportunity).toHaveBeenCalledOnce()
    expect(mocks.db.demoRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { status: DemoRunStatus.AWAITING_OWNER_SIGNATURE },
    })
  })
})

describe('Terac study completion replay', () => {
  const providerResult = {
    externalId: 'terac-study-1',
    live: false,
    status: 'COMPLETED' as const,
    data: {
      status: 'COMPLETE' as const,
      studyId: 'terac-study-1',
      winnerId: 'candidate-b',
      source: 'rubric' as const,
      respondentCount: 8,
      baselineScores: { candidateId: 'baseline', clarity: 40, trust: 40, relevance: 40 },
      scores: [
        { candidateId: 'candidate-a', clarity: 61, trust: 62, relevance: 63 },
        { candidateId: 'candidate-b', clarity: 70, trust: 71, relevance: 72 },
      ],
    },
  }
  const expectedEvidence = {
    demoRunId: 'run-1',
    provider: Provider.TERAC,
    externalId: 'terac-study-1',
    live: false,
    status: 'COMPLETE',
    baselineScore: 40,
    selectedScore: 71,
    scoreDelta: 31,
    respondentCount: 8,
    rubric: {
      baseline: providerResult.data.baselineScores,
      selected: providerResult.data.scores[1],
    },
    selectedRevisionId: 'candidate-b',
  }

  function configureState(
    runStatus: DemoRunStatus,
    winnerStatus: RevisionStatus,
    durableEvidence: typeof expectedEvidence | null,
    mode: 'FAKE' | 'JUDGE' = 'FAKE',
  ) {
    const state = { runStatus, winnerStatus, durableEvidence }
    mocks.db.demoRun.findUniqueOrThrow.mockResolvedValue({
      id: 'run-1',
      mode,
      status: runStatus,
      campaign: {
        revisions: [
          { id: 'baseline', label: 'Baseline', body: { copy: 'baseline' }, status: RevisionStatus.UNDER_STUDY },
          { id: 'candidate-a', label: 'Candidate A', body: { copy: 'a' }, status: RevisionStatus.UNDER_STUDY },
          { id: 'candidate-b', label: 'Candidate B', body: { copy: 'b' }, status: winnerStatus },
        ],
      },
    })
    mocks.db.demoRun.updateMany.mockImplementation(async ({ where, data }) => {
      if (state.runStatus !== where.status) return { count: 0 }
      state.runStatus = data.status
      return { count: 1 }
    })
    mocks.db.campaignRevision.updateMany.mockImplementation(async ({ where, data }) => {
      if (state.winnerStatus !== where.status) return { count: 0 }
      state.winnerStatus = data.status
      return { count: 1 }
    })
    mocks.db.humanStudy.findUnique.mockImplementation(async () => state.durableEvidence)
    mocks.db.humanStudy.upsert.mockImplementation(async ({ create }) => {
      state.durableEvidence ??= create
      return state.durableEvidence
    })
    return state
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.db.$transaction.mockImplementation(async (callback) => callback(mocks.db))
    mocks.db.providerAction.upsert.mockResolvedValue({ id: 'provider-action-1' })
    mocks.dispatchProviderAction.mockResolvedValue(providerResult)
    mocks.db.event.findFirst.mockResolvedValue(null)
  })

  it('persists evidence once and advances only the first normal completion', async () => {
    const state = configureState(DemoRunStatus.STUDY_RUNNING, RevisionStatus.UNDER_STUDY, null)

    await runTeracCampaignStudy('run-1', new Map())

    expect(state.runStatus).toBe(DemoRunStatus.AWAITING_CAMPAIGN_APPROVAL)
    expect(state.winnerStatus).toBe(RevisionStatus.READY_FOR_APPROVAL)
    expect(state.durableEvidence).toEqual(expectedEvidence)
    expect(mocks.db.humanStudy.upsert).toHaveBeenCalledTimes(1)
    expect(mocks.appendRunEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'study.completed',
      summary: expect.stringMatching(/Mock demo route.*no human Terac study was run/i),
      actor: 'mock-demo',
    }))
  })

  it('uses live Terac attribution for a live campaign result', async () => {
    configureState(DemoRunStatus.STUDY_RUNNING, RevisionStatus.UNDER_STUDY, null)
    mocks.dispatchProviderAction.mockResolvedValue({ ...providerResult, live: true })

    await runTeracCampaignStudy('run-1', new Map())

    expect(mocks.appendRunEvent).toHaveBeenCalledWith('run-1', expect.objectContaining({
      type: 'study.completed',
      summary: 'Terac selected Candidate B with a 31.00-point average lift.',
      actor: 'terac',
    }))
  })

  it('returns successfully after approval without demoting the active revision or run', async () => {
    const state = configureState(DemoRunStatus.RUNNING, RevisionStatus.ACTIVE, expectedEvidence)

    await runTeracCampaignStudy('run-1', new Map())

    expect(state.runStatus).toBe(DemoRunStatus.RUNNING)
    expect(state.winnerStatus).toBe(RevisionStatus.ACTIVE)
    expect(mocks.db.campaignRevision.updateMany).not.toHaveBeenCalled()
    expect(mocks.db.humanStudy.upsert).not.toHaveBeenCalled()
  })

  it('returns successfully after rejection without moving the paused run back to approval', async () => {
    const state = configureState(DemoRunStatus.PAUSED, RevisionStatus.READY_FOR_APPROVAL, expectedEvidence)

    await runTeracCampaignStudy('run-1', new Map())

    expect(state.runStatus).toBe(DemoRunStatus.PAUSED)
    expect(state.winnerStatus).toBe(RevisionStatus.READY_FOR_APPROVAL)
    expect(mocks.db.campaignRevision.updateMany).not.toHaveBeenCalled()
    expect(mocks.db.humanStudy.upsert).not.toHaveBeenCalled()
  })

  it('fails closed when an advanced run has conflicting durable evidence', async () => {
    const state = configureState(DemoRunStatus.RUNNING, RevisionStatus.ACTIVE, {
      ...expectedEvidence,
      selectedRevisionId: 'candidate-a',
    })

    await expect(runTeracCampaignStudy('run-1', new Map())).rejects.toThrow(/conflicts with durable study evidence/)

    expect(state.runStatus).toBe(DemoRunStatus.RUNNING)
    expect(state.winnerStatus).toBe(RevisionStatus.ACTIVE)
    expect(mocks.db.campaignRevision.updateMany).not.toHaveBeenCalled()
  })

  it('rejects mock Terac respondent proof in a judged run', async () => {
    const state = configureState(DemoRunStatus.STUDY_RUNNING, RevisionStatus.UNDER_STUDY, null, 'JUDGE')

    await expect(runTeracCampaignStudy('run-1', new Map())).rejects.toThrow(/must be live.*mock respondent proof/i)

    expect(state.runStatus).toBe(DemoRunStatus.STUDY_RUNNING)
    expect(state.winnerStatus).toBe(RevisionStatus.UNDER_STUDY)
    expect(mocks.db.$transaction).not.toHaveBeenCalled()
    expect(mocks.appendRunEvent).not.toHaveBeenCalled()
  })
})

describe('Documenso buyer consent evidence', () => {
  const buyerEmail = 'anja@nordlicht.example'
  const acceptedAt = new Date('2026-08-15T10:00:03.000Z')
  const buyerContact = {
    name: 'Anja Keller',
    consented: true,
    rolePlayer: true,
    addressHash: recipientFingerprint(buyerEmail),
  }
  const acceptance = {
    demoRunId: 'run-1',
    opportunityId: 'opp-nordlicht',
    type: 'agreement.accepted',
    actor: 'linq',
    proofRef: 'linq-acceptance-1',
    occurredAt: acceptedAt,
  }
  const receipt = {
    demoRunId: 'run-1',
    provider: Provider.LINQ,
    externalEventId: 'linq-acceptance-1',
    eventType: 'message.received',
    processedAt: new Date('2026-08-15T10:00:04.000Z'),
  }

  it('returns the persisted contact identity and acceptance timestamp without the configured email', () => {
    const buyer = documensoBuyerFromLinqAcceptance(
      buyerContact,
      buyerEmail,
      acceptance,
      receipt,
      { demoRunId: 'run-1', opportunityId: 'opp-nordlicht' },
    )
    expect(buyer).toEqual({
      name: 'Anja Keller',
      identityRole: 'buyer',
      consentedAt: '2026-08-15T10:00:03.000Z',
    })
    const serializedActionRequest = JSON.stringify(documensoEnvelopeRequest(buyer))
    expect(serializedActionRequest).not.toMatch(/anja@nordlicht\.example|email/i)
  })

  it('rejects an arbitrary buyer email that is not the consenting contact identity', () => {
    expect(() => documensoBuyerFromLinqAcceptance(
      buyerContact,
      'arbitrary@example.com',
      acceptance,
      receipt,
      { demoRunId: 'run-1', opportunityId: 'opp-nordlicht' },
    )).toThrow(/does not match/)
  })

  it('rejects missing or unprocessed explicit acceptance evidence', () => {
    expect(() => documensoBuyerFromLinqAcceptance(
      buyerContact,
      buyerEmail,
      null,
      receipt,
      { demoRunId: 'run-1', opportunityId: 'opp-nordlicht' },
    )).toThrow(/explicit Linq acceptance/)
    expect(() => documensoBuyerFromLinqAcceptance(
      buyerContact,
      buyerEmail,
      acceptance,
      { ...receipt, processedAt: null },
      { demoRunId: 'run-1', opportunityId: 'opp-nordlicht' },
    )).toThrow(/processed Linq acceptance receipt/)
  })

  it('accepts the exact durably in-flight receipt only for hybrid inline processing', () => {
    const inFlightReceipt = { ...receipt, processedAt: null, processingToken: 'linq-processing-lease' }

    expect(documensoBuyerFromLinqAcceptance(
      buyerContact,
      buyerEmail,
      acceptance,
      inFlightReceipt,
      { demoRunId: 'run-1', opportunityId: 'opp-nordlicht', allowInFlightReceipt: true },
    )).toEqual({
      name: 'Anja Keller',
      identityRole: 'buyer',
      consentedAt: '2026-08-15T10:00:03.000Z',
    })
    expect(() => documensoBuyerFromLinqAcceptance(
      buyerContact,
      buyerEmail,
      acceptance,
      inFlightReceipt,
      { demoRunId: 'run-1', opportunityId: 'opp-nordlicht' },
    )).toThrow(/processed Linq acceptance receipt/)
  })
})

describe('Monid materialization collision gate', () => {
  it('skips a seeded company name instead of overwriting it with Monid data', () => {
    const seeded = { id: 'seeded-nordlicht', monidProviderId: null, researchOnly: false }
    expect(resolveMonidCompanyMatch(null, seeded, 'monid-company-1')).toEqual({
      action: 'SKIP_COLLISION',
    })
  })

  it('reuses the existing Monid company on retry', () => {
    const discovered = { id: 'discovered-1', monidProviderId: 'monid-company-1', researchOnly: true }
    expect(resolveMonidCompanyMatch(discovered, null, 'monid-company-1')).toEqual({
      action: 'USE',
      company: discovered,
    })
  })
})

describe('Band workflow policy gate', () => {
  it('uses only the verified inbound body as the buyer brief', () => {
    const request = bandRequestFromInbound('Buyer asked to discuss delivery timing.')
    expect(request).toEqual({
      brief: 'Seller context: the preceding outreach proposed a two-container furniture pilot at a EUR 172 per-seat target, subject to later contract review. Buyer reply: Buyer asked to discuss delivery timing.',
      currency: 'EUR',
      localPolicy: 'Seller target EUR 172 per seat; hard floor EUR 158 per seat. An affirmative reply to initial outreach is engagement, not binding acceptance. If the buyer is interested and made no below-floor counteroffer, recommend sending a non-binding EUR 172 proposal; quantity and legal terms may remain for contract review. Do not make binding legal claims. Local policy is authoritative.',
    })
    expect(request).not.toHaveProperty('askingPrice')
    expect(request.brief).not.toMatch(/40HQ|boucl|German law/i)
  })

  it('rejects an empty sanitized inbound body', () => {
    expect(() => bandRequestFromInbound('   ')).toThrow(/no usable sanitized body/)
  })

  it('approves a schema-valid price at or above the local floor', () => {
    expect(evaluateBandVerdict(verdict)).toMatchObject({ outcome: 'APPROVE', proposedPrice: 172 })
  })

  it('pauses a below-floor proposal locally', () => {
    expect(evaluateBandVerdict({ ...verdict, proposedPrice: 157 })).toMatchObject({
      outcome: 'PAUSE',
      reason: 'POLICY_BELOW_FLOOR',
    })
  })

  it('fails a proceed verdict without a usable price', () => {
    expect(() => evaluateBandVerdict({ ...verdict, proposedPrice: null })).toThrow(/malformed verdict/)
  })

  it('pauses rejection before any proposal can be sent', () => {
    expect(evaluateBandVerdict({ ...verdict, recommendation: 'REJECT' })).toMatchObject({
      outcome: 'PAUSE',
      reason: 'BAND_REJECT',
    })
  })
})
