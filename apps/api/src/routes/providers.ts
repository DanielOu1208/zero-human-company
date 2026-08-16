import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ApprovalDecision, ApprovalKind, DemoRunStatus, OpportunityStage, PilotStatus, Prisma, Provider, RunMode } from '@prisma/client'
import Stripe from 'stripe'
import { requireOwner } from '../auth.js'
import { getConfig } from '../config.js'
import { db } from '../db.js'
import { appendRunEvent, getDemoRunSnapshot, recordOwnerSignature, transitionOpportunity } from '../domain/demo-service.js'
import { evaluatePricePolicy } from '../domain/policy.js'
import { httpError } from '../http-errors.js'
import { dispatchProviderAction } from '../outbox.js'
import { parseDocumensoWebhook } from '../providers/documenso/index.js'
import { isExplicitAcceptance, parseMaasSeatPrice, verifyLinqWebhook } from '../providers/linq/index.js'
import { createProviderRegistry } from '../providers/registry.js'
import { verifyStripeCheckoutCompleted } from '../providers/stripe/index.js'
import { triggerRenderTask } from '../workflows/render-client.js'

type RawRequest = FastifyRequest & { rawBody?: string }

function payloadHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export type ProviderReceiptStatus = 'NEW' | 'RESUME' | 'DONE' | 'BUSY'

export type ProviderReceiptClaim =
  | { status: 'NEW' | 'RESUME'; receiptId: string; leaseToken: string }
  | { status: 'DONE' }
  | { status: 'BUSY' }

type NegotiationProposalEvidence = {
  action: {
    demoRunId: string
    provider: Provider
    kind: string
    idempotencyKey: string
    status: string
    live: boolean
    providerExternalId: string | null
  } | null
  message: {
    demoRunId: string
    opportunityId: string
    direction: string
    live: boolean
    externalId: string | null
  } | null
}

const manualWorkflowTaskSlugs = [
  'run-terac-campaign-study',
  'discover-research-leads',
  'send-nordlicht-outreach',
  'run-band-negotiation',
  'review-contract-and-create-envelope',
  'prove-render-retry',
] as const

type ManualWorkflowTaskSlug = (typeof manualWorkflowTaskSlugs)[number]

type ManualTaskPhase = {
  runStatus: DemoRunStatus
  pilotStatus: PilotStatus | null
  campaignApproved: boolean
  opportunityStages: Partial<Record<'Nordlicht Import GmbH' | 'Maas Interiors BV', OpportunityStage>>
}

export function manualTaskPhaseIsAllowed(slug: ManualWorkflowTaskSlug, phase: ManualTaskPhase): boolean {
  if (phase.pilotStatus !== PilotStatus.PAID) return false
  if (slug === 'run-terac-campaign-study') return phase.runStatus === DemoRunStatus.STUDY_RUNNING
  if (phase.runStatus !== DemoRunStatus.RUNNING || !phase.campaignApproved) return false
  if (slug === 'send-nordlicht-outreach') {
    return phase.opportunityStages['Nordlicht Import GmbH'] === OpportunityStage.RESEARCHING
      && phase.opportunityStages['Maas Interiors BV'] === OpportunityStage.RESEARCHING
  }
  if (slug === 'run-band-negotiation') {
    return phase.opportunityStages['Nordlicht Import GmbH'] === OpportunityStage.ENGAGED
  }
  if (slug === 'review-contract-and-create-envelope') {
    return phase.opportunityStages['Nordlicht Import GmbH'] === OpportunityStage.AGREEMENT
  }
  return true
}

export function assertManualTaskPhase(slug: ManualWorkflowTaskSlug, phase: ManualTaskPhase): void {
  if (!manualTaskPhaseIsAllowed(slug, phase)) {
    throw httpError(409, 'Workflow task is not available in the current run phase')
  }
}

type LinqOutboundCandidate = {
  id: string
  demoRunId: string
  opportunityId: string
  live: boolean
  occurredAt: Date
  opportunity: {
    stage: OpportunityStage
    stageReason: string | null
    demoRun: { status: DemoRunStatus }
    company: { name: string }
    contact: { consented: boolean; rolePlayer: boolean; addressHash: string | null } | null
  }
}

const actionableLinqRunStatuses = new Set<DemoRunStatus>([
  DemoRunStatus.RUNNING,
  DemoRunStatus.AWAITING_OWNER_SIGNATURE,
])
const actionableNordlichtStages = new Set<OpportunityStage>([
  OpportunityStage.OUTREACH,
  OpportunityStage.ENGAGED,
  OpportunityStage.NEGOTIATING,
  OpportunityStage.AGREEMENT,
  OpportunityStage.SIGNING,
  OpportunityStage.PAUSED,
])

function isEligibleLinqOutbound(candidate: LinqOutboundCandidate, senderFingerprint: string): boolean {
  const { opportunity } = candidate
  if (!candidate.live || !actionableLinqRunStatuses.has(opportunity.demoRun.status)) return false
  const contact = opportunity.contact
  if (!contact?.consented || !contact.rolePlayer || contact.addressHash !== senderFingerprint) return false
  if (opportunity.company.name === 'Nordlicht Import GmbH') {
    return actionableNordlichtStages.has(opportunity.stage)
      && (opportunity.stage !== OpportunityStage.PAUSED || opportunity.stageReason === 'BAND_ESCALATE')
  }
  return opportunity.company.name === 'Maas Interiors BV' && opportunity.stage === OpportunityStage.OUTREACH
}

export function selectEligibleLinqOutbound(
  candidates: readonly LinqOutboundCandidate[],
  senderFingerprint: string,
): { status: 'MATCHED'; outbound: LinqOutboundCandidate } | { status: 'UNMATCHED' } | { status: 'AMBIGUOUS' } {
  const latestByOpportunity = new Map<string, LinqOutboundCandidate>()
  for (const candidate of candidates) {
    const contact = candidate.opportunity.contact
    const company = candidate.opportunity.company.name
    if (
      !candidate.live
      || !contact?.consented
      || !contact.rolePlayer
      || contact.addressHash !== senderFingerprint
      || (company !== 'Nordlicht Import GmbH' && company !== 'Maas Interiors BV')
    ) continue
    const key = `${candidate.demoRunId}:${candidate.opportunityId}`
    const current = latestByOpportunity.get(key)
    if (!current || candidate.occurredAt > current.occurredAt) latestByOpportunity.set(key, candidate)
  }
  const identityMatches = [...latestByOpportunity.values()]
  // Linq reuses a role-player chat across sends. Without a provider-signed
  // reply-to message ID, any historical second run on that chat makes a reply
  // causally ambiguous, even when only the newest run is active. Never guess.
  if (identityMatches.length > 1) return { status: 'AMBIGUOUS' }
  if (identityMatches.length === 0 || !isEligibleLinqOutbound(identityMatches[0], senderFingerprint)) {
    return { status: 'UNMATCHED' }
  }
  return { status: 'MATCHED', outbound: identityMatches[0] }
}

export function isDurablyDeliveredNegotiationProposal(
  evidence: NegotiationProposalEvidence,
  expected: { demoRunId: string; opportunityId: string },
): boolean {
  const prefix = `linq-negotiation-proposal:${expected.demoRunId}:${expected.opportunityId}:`
  return evidence.action?.demoRunId === expected.demoRunId
    && evidence.action.provider === Provider.LINQ
    && evidence.action.kind === 'message.send'
    && evidence.action.idempotencyKey.startsWith(prefix)
    && evidence.action.status === 'SUCCEEDED'
    && evidence.action.live
    && Boolean(evidence.action.providerExternalId)
    && evidence.message?.demoRunId === expected.demoRunId
    && evidence.message.opportunityId === expected.opportunityId
    && evidence.message.direction === 'OUTBOUND'
    && evidence.message.live
    && evidence.message.externalId === evidence.action.providerExternalId
}

type ProviderEventInput = {
  demoRunId: string
  provider: Provider
  externalEventId: string
  eventType: string
  raw: string
}

export function providerEventCreateData(input: ProviderEventInput) {
  return {
    demoRunId: input.demoRunId,
    provider: input.provider,
    externalEventId: input.externalEventId,
    eventType: input.eventType,
    payloadHash: payloadHash(input.raw),
  }
}

export function classifyExistingProviderReceipt(
  existing: { payloadHash: string; demoRunId: string; eventType: string; processedAt: Date | null },
  incoming: { payloadHash: string; demoRunId: string; eventType: string },
): 'RESUME' | 'DONE' {
  const payloadMatches = existing.payloadHash === incoming.payloadHash
  const targetMatches = existing.demoRunId === incoming.demoRunId && existing.eventType === incoming.eventType
  if (!payloadMatches || !targetMatches) {
    const error = new Error('Provider event id was reused with a different payload or target') as Error & { statusCode: number }
    error.statusCode = 409
    throw error
  }
  return existing.processedAt ? 'DONE' : 'RESUME'
}

type ProviderReceiptRecord = {
  id: string
  payloadHash: string
  demoRunId: string
  eventType: string
  processedAt: Date | null
}

type ProviderReceiptStore = {
  create(args: { data: Record<string, unknown> }): Promise<ProviderReceiptRecord>
  findUniqueOrThrow(args: { where: Record<string, unknown> }): Promise<ProviderReceiptRecord>
  findUnique(args: { where: Record<string, unknown> }): Promise<ProviderReceiptRecord | null>
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

type ProviderReceiptClaimOptions = {
  store?: ProviderReceiptStore
  now?: Date
  leaseToken?: string
}

const providerReceiptStore = db.providerEvent as unknown as ProviderReceiptStore
const PROVIDER_RECEIPT_LEASE_MS = 15 * 60 * 1_000

function assertProviderActionRunMode(mode: RunMode): void {
  const config = getConfig()
  const expectedMode = config.DEMO_HYBRID_MODE || config.PROVIDER_MODE !== 'real'
    ? RunMode.FAKE
    : RunMode.JUDGE
  if (mode === expectedMode) return
  if (expectedMode === RunMode.JUDGE) {
    throw httpError(409, 'Real provider actions require a JUDGE run')
  }
  throw httpError(409, config.DEMO_HYBRID_MODE
    ? 'Hybrid provider actions require a FAKE run'
    : 'Fake provider actions require a FAKE run')
}

function isUniqueViolation(error: unknown): boolean {
  return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
    || (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002')
}

export async function claimProviderEvent(
  input: ProviderEventInput,
  options: ProviderReceiptClaimOptions = {},
): Promise<ProviderReceiptClaim> {
  const store = options.store ?? providerReceiptStore
  const now = options.now ?? new Date()
  const leaseToken = options.leaseToken ?? randomUUID()
  const processingExpiresAt = new Date(now.getTime() + PROVIDER_RECEIPT_LEASE_MS)
  const createData = providerEventCreateData(input)
  try {
    const created = await store.create({ data: { ...createData, processingToken: leaseToken, processingExpiresAt } })
    return { status: 'NEW', receiptId: created.id, leaseToken }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const existing = await store.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: input.provider, externalEventId: input.externalEventId } },
    })
    const status = classifyExistingProviderReceipt(existing, {
      payloadHash: createData.payloadHash,
      demoRunId: input.demoRunId,
      eventType: input.eventType,
    })
    if (status === 'DONE') return { status }
    const claimed = await store.updateMany({
      where: {
        id: existing.id,
        processedAt: null,
        OR: [
          { processingToken: null },
          { processingExpiresAt: null },
          { processingExpiresAt: { lte: now } },
        ],
      },
      data: { processingToken: leaseToken, processingExpiresAt },
    })
    if (claimed.count === 1) return { status: 'RESUME', receiptId: existing.id, leaseToken }
    const latest = await store.findUnique({ where: { id: existing.id } })
    return latest?.processedAt ? { status: 'DONE' } : { status: 'BUSY' }
  }
}

async function markProviderEventProcessed(claim: Extract<ProviderReceiptClaim, { leaseToken: string }>): Promise<void> {
  const updated = await db.providerEvent.updateMany({
    where: { id: claim.receiptId, processedAt: null, processingToken: claim.leaseToken },
    data: { processedAt: new Date(), processingToken: null, processingExpiresAt: null },
  })
  if (updated.count !== 1) throw httpError(503, 'Provider event processing lease was lost before completion')
}

async function releaseProviderEventClaim(claim: Extract<ProviderReceiptClaim, { leaseToken: string }>): Promise<void> {
  await db.providerEvent.updateMany({
    where: { id: claim.receiptId, processedAt: null, processingToken: claim.leaseToken },
    data: { processingToken: null, processingExpiresAt: null },
  })
}

async function processProviderEventClaim<T>(
  claim: Extract<ProviderReceiptClaim, { leaseToken: string }>,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation()
    await markProviderEventProcessed(claim)
    return result
  } catch (error) {
    await releaseProviderEventClaim(claim)
    throw error
  }
}

async function appendRunEventOnce(
  demoRunId: string,
  event: Parameters<typeof appendRunEvent>[1],
): Promise<void> {
  if (event.proofRef) {
    const existing = await db.event.count({
      where: { demoRunId, opportunityId: event.opportunityId ?? null, type: event.type, proofRef: event.proofRef },
    })
    if (existing) return
  }
  try {
    await appendRunEvent(demoRunId, event)
  } catch (error) {
    if (event.proofRef && isUniqueViolation(error)) return
    throw error
  }
}

async function ensureRenderTask(
  demoRunId: string,
  taskSlug: 'run-terac-campaign-study' | 'run-band-negotiation' | 'review-contract-and-create-envelope',
): Promise<void> {
  await triggerRenderTask(demoRunId, taskSlug)
}

async function currentOpportunityStage(opportunityId: string): Promise<OpportunityStage> {
  const opportunity = await db.opportunity.findUniqueOrThrow({ where: { id: opportunityId } })
  return opportunity.stage
}

async function negotiationProposalWasDelivered(demoRunId: string, opportunityId: string): Promise<boolean> {
  const action = await db.providerAction.findFirst({
    where: {
      demoRunId,
      provider: Provider.LINQ,
      kind: 'message.send',
      idempotencyKey: { startsWith: `linq-negotiation-proposal:${demoRunId}:${opportunityId}:` },
      status: 'SUCCEEDED',
      live: true,
      providerExternalId: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
  })
  const message = action?.providerExternalId
    ? await db.message.findUnique({
        where: { provider_externalId: { provider: Provider.LINQ, externalId: action.providerExternalId } },
      })
    : null
  return isDurablyDeliveredNegotiationProposal({ action, message }, { demoRunId, opportunityId })
}

function requireStage(stage: OpportunityStage, allowed: readonly OpportunityStage[], context: string): void {
  if (!allowed.includes(stage)) throw new Error(`${context} is invalid while opportunity is ${stage}`)
}

function requireDocumensoExternalId(eventExternalId: string, demoRunId: string, opportunityId: string): void {
  if (eventExternalId !== `documenso:${demoRunId}:${opportunityId}`) {
    throw new Error('Documenso externalId does not match the stored run and opportunity')
  }
}

export function inboundMessageBody(input: { optedOut: boolean; companyName: string; text: string }): string {
  if (input.optedOut) return 'Role-player opted out.'

  const rolePlayer = input.companyName === 'Maas Interiors BV' ? 'Maas' : 'Nordlicht'
  const facts: string[] = []
  if (isExplicitAcceptance(input.text)) facts.push('explicitly accepted')
  const price = parseMaasSeatPrice(input.text)
  if (price !== null) facts.push(`stated EUR ${price}/seat`)

  return facts.length
    ? `Consenting ${rolePlayer} role-player ${facts.join(' and ')}.`
    : `Consenting ${rolePlayer} role-player replied; free text withheld.`
}

export function registerProviderRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>('/api/v1/demo-runs/:id/activate', { preHandler: requireOwner }, async (request) => {
    const run = await db.demoRun.findUniqueOrThrow({ where: { id: request.params.id }, include: { workspace: { include: { pilotActivation: true } } } })
    assertProviderActionRunMode(run.mode)
    const pilot = run.workspace.pilotActivation
    if (!pilot || run.status !== DemoRunStatus.AWAITING_PAYMENT) throw httpError(409, 'Run is not awaiting pilot payment')
    const action = await db.providerAction.upsert({
      where: { idempotencyKey: `stripe-checkout:${run.id}:${pilot.id}` },
      create: { demoRunId: run.id, provider: Provider.STRIPE, kind: 'checkout.session.create', idempotencyKey: `stripe-checkout:${run.id}:${pilot.id}`, request: { pilotActivationId: pilot.id } },
      update: {},
    })
    const result = await dispatchProviderAction(action.id, createProviderRegistry())
    const data = result.data as { checkoutUrl?: string }
    if (!data.checkoutUrl) throw new Error('Stripe returned no checkout URL')
    await db.pilotActivation.update({ where: { id: pilot.id }, data: { checkoutUrl: data.checkoutUrl } })
    return { checkoutUrl: data.checkoutUrl }
  })

  app.post('/webhooks/stripe', { config: { rawBody: true } }, async (request, reply) => {
    const config = getConfig()
    if (!config.STRIPE_SECRET_KEY || !config.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook is not configured')
    const raw = (request as RawRequest).rawBody ?? ''
    const signature = header(request.headers['stripe-signature'])
    const stripe = new Stripe(config.STRIPE_SECRET_KEY)
    const signed = stripe.webhooks.constructEvent(raw, signature, config.STRIPE_WEBHOOK_SECRET)
    if (signed.type !== 'checkout.session.completed') return reply.code(200).send({ received: true, ignored: true })
    const session = signed.data.object
    const demoRunId = session.metadata?.demoRunId ?? ''
    const pilotActivationId = session.metadata?.pilotActivationId ?? ''
    const proof = verifyStripeCheckoutCompleted(stripe, raw, signature, config.STRIPE_WEBHOOK_SECRET, { demoRunId, pilotActivationId }, config.STRIPE_MODE)
    const run = await db.demoRun.findUniqueOrThrow({
      where: { id: demoRunId },
      include: { workspace: { include: { pilotActivation: true } } },
    })
    if (run.workspace.pilotActivation?.id !== pilotActivationId) {
      throw new Error('Stripe metadata does not match the run pilot activation')
    }
    const claim = await claimProviderEvent({ demoRunId, provider: Provider.STRIPE, externalEventId: proof.stripeEventId, eventType: signed.type, raw })
    if (claim.status === 'DONE') return reply.code(200).send({ received: true, duplicate: true })
    if (claim.status === 'BUSY') throw httpError(503, 'Stripe event is already being processed; retry later')

    const response = await processProviderEventClaim(claim, async () => {
      await db.payment.upsert({
        where: { stripeEventId: proof.stripeEventId },
        create: {
          demoRunId,
          pilotActivationId,
          stripeEventId: proof.stripeEventId,
          checkoutSessionId: proof.checkoutSessionId,
          paymentIntentId: proof.paymentIntentId,
          livemode: proof.livemode,
          providerMode: proof.providerMode,
          amount: proof.amount,
          currency: proof.currency,
          status: 'COMPLETED',
        },
        update: {},
      })
      await db.pilotActivation.updateMany({
        where: { id: pilotActivationId, workspaceId: run.workspaceId, status: PilotStatus.PENDING },
        data: { status: PilotStatus.PAID, paidAt: new Date() },
      })
      await db.demoRun.updateMany({
        where: { id: demoRunId, workspaceId: run.workspaceId, status: DemoRunStatus.AWAITING_PAYMENT },
        data: { status: DemoRunStatus.STUDY_RUNNING },
      })
      await appendRunEventOnce(demoRunId, {
        type: 'payment.completed',
        status: 'PAID',
        summary: `Signed Stripe ${proof.providerMode.toLowerCase()} webhook confirmed the $5 pilot activation.`,
        actor: 'stripe',
        proofRef: proof.stripeEventId,
      })
      await ensureRenderTask(demoRunId, 'run-terac-campaign-study')
      return { received: true, resumed: claim.status === 'RESUME' }
    })
    return reply.code(200).send(response)
  })

  app.post('/webhooks/linq', { config: { rawBody: true } }, async (request, reply) => {
    const config = getConfig()
    if (!config.LINQ_WEBHOOK_SECRET) throw new Error('Linq webhook is not configured')
    const raw = (request as RawRequest).rawBody ?? ''
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, header(value)]))
    const event = verifyLinqWebhook(raw, headers, config.LINQ_WEBHOOK_SECRET)
    if (event.eventType !== 'message.received') return reply.code(202).send({ received: true, ignored: true })
    if (!event.chatId || !event.messageId || !event.text || !event.senderFingerprint) {
      return reply.code(202).send({ received: true, ignored: true })
    }
    const chatId = event.chatId
    const messageId = event.messageId
    const text = event.text
    const senderFingerprint = event.senderFingerprint
    const candidates = await db.message.findMany({
      where: { threadExternalId: chatId, direction: 'OUTBOUND' },
      include: { opportunity: { include: { demoRun: true, company: true, contact: true } } },
      orderBy: { occurredAt: 'desc' },
    })
    const selection = selectEligibleLinqOutbound(candidates, senderFingerprint)
    if (selection.status === 'UNMATCHED') return reply.code(202).send({ received: true, unmatched: true })
    if (selection.status === 'AMBIGUOUS') return reply.code(202).send({ received: true, ambiguous: true })
    const outbound = selection.outbound
    const claim = await claimProviderEvent({ demoRunId: outbound.demoRunId, provider: Provider.LINQ, externalEventId: event.eventId, eventType: event.eventType, raw })
    if (claim.status === 'DONE') return reply.code(200).send({ received: true, duplicate: true })
    if (claim.status === 'BUSY') throw httpError(503, 'Linq event is already being processed; retry later')
    const response = await processProviderEventClaim(claim, async () => {
      const companyName = outbound.opportunity.company.name
      if (companyName !== 'Nordlicht Import GmbH' && companyName !== 'Maas Interiors BV') {
        throw new Error('Linq reply matched an unsupported company')
      }
      await db.message.upsert({
        where: { provider_externalId: { provider: Provider.LINQ, externalId: messageId } },
        create: {
          demoRunId: outbound.demoRunId,
          opportunityId: outbound.opportunityId,
          externalId: messageId,
          threadExternalId: chatId,
          direction: 'INBOUND',
          status: 'RECEIVED',
          sanitizedBody: inboundMessageBody({ optedOut: event.optedOut, companyName, text }),
          rolePlayer: true,
          live: outbound.live,
        },
        update: {},
      })
      let stage = await currentOpportunityStage(outbound.opportunityId)
      if (event.optedOut) {
        if (stage !== OpportunityStage.LOST) {
          requireStage(stage, [OpportunityStage.OUTREACH, OpportunityStage.ENGAGED, OpportunityStage.NEGOTIATING, OpportunityStage.AGREEMENT, OpportunityStage.SIGNING], 'Linq opt-out')
          await transitionOpportunity({ opportunityId: outbound.opportunityId, to: 'LOST', reason: 'OPT_OUT', eventType: 'contact.opted_out', summary: 'Role-player opted out; all outreach stopped.', actor: 'linq', proofRef: event.eventId })
        }
      } else if (companyName === 'Maas Interiors BV') {
        const offeredPrice = parseMaasSeatPrice(text)
        if (offeredPrice !== null) {
          const decision = evaluatePricePolicy({ offeredPrice, floorPrice: 158, currency: 'EUR', unit: 'seat' })
          if (decision.outcome === 'PAUSE' && stage !== OpportunityStage.PAUSED) {
            requireStage(stage, [OpportunityStage.OUTREACH], 'Maas price-policy reply')
            await transitionOpportunity({ opportunityId: outbound.opportunityId, to: 'PAUSED', reason: decision.reason, eventType: 'policy.blocked', summary: `${decision.summary}; no reply was sent.`, actor: 'policy-engine', proofRef: event.eventId })
          }
        }
      } else if (stage === OpportunityStage.OUTREACH) {
        await transitionOpportunity({ opportunityId: outbound.opportunityId, to: 'ENGAGED', eventType: 'reply.received', summary: 'The consenting Nordlicht role-player replied.', actor: 'linq', proofRef: event.eventId })
        stage = OpportunityStage.ENGAGED
      } else if (stage === OpportunityStage.PAUSED && outbound.opportunity.stageReason === 'BAND_ESCALATE') {
        await transitionOpportunity({ opportunityId: outbound.opportunityId, to: 'ENGAGED', reason: null, eventType: 'reply.clarified', summary: 'The consenting Nordlicht role-player clarified the paused negotiation.', actor: 'linq', proofRef: event.eventId })
        stage = OpportunityStage.ENGAGED
      } else if (stage === OpportunityStage.NEGOTIATING && isExplicitAcceptance(text)) {
        if (!await negotiationProposalWasDelivered(outbound.demoRunId, outbound.opportunityId)) {
          throw httpError(503, 'Buyer acceptance arrived before proposal delivery was durably recorded; retry later')
        }
        await transitionOpportunity({ opportunityId: outbound.opportunityId, to: 'AGREEMENT', eventType: 'agreement.accepted', summary: 'The consenting Nordlicht role-player explicitly accepted.', actor: 'linq', proofRef: event.eventId })
        stage = OpportunityStage.AGREEMENT
      }
      if (!event.optedOut && companyName === 'Nordlicht Import GmbH' && stage === OpportunityStage.ENGAGED) {
        await ensureRenderTask(outbound.demoRunId, 'run-band-negotiation')
      }
      if (!event.optedOut && companyName === 'Nordlicht Import GmbH' && stage === OpportunityStage.AGREEMENT && isExplicitAcceptance(text)) {
        await ensureRenderTask(outbound.demoRunId, 'review-contract-and-create-envelope')
      }
      return { received: true, resumed: claim.status === 'RESUME' }
    })
    return reply.code(200).send(response)
  })

  app.post('/webhooks/documenso', async (request, reply) => {
    const config = getConfig()
    if (!config.DOCUMENSO_WEBHOOK_SECRET) throw new Error('Documenso webhook is not configured')
    if (!config.DOCUMENSO_BUYER_EMAIL) throw new Error('Documenso buyer signer is not configured')
    const event = parseDocumensoWebhook(
      { headers: request.headers, body: request.body },
      config.DOCUMENSO_WEBHOOK_SECRET,
      { ownerEmail: config.OWNER_EMAIL, buyerEmail: config.DOCUMENSO_BUYER_EMAIL },
    )
    if (!event) return reply.code(202).send({ received: true, ignored: true })
    const document = await db.document.findUniqueOrThrow({
      where: { provider_externalId: { provider: Provider.DOCUMENSO, externalId: event.documentId } },
      include: { opportunity: true, demoRun: true },
    })
    if (document.opportunityId !== document.opportunity.id || document.demoRunId !== document.opportunity.demoRunId) {
      throw new Error('Documenso document does not match its stored run and opportunity')
    }
    if (event.externalId !== undefined) {
      requireDocumensoExternalId(event.externalId, document.demoRunId, document.opportunityId)
    }
    const raw = JSON.stringify(request.body)
    const receiptExternalEventId = `${event.documentId}:${event.sourceEventType}:${event.occurredAt}`
    const effectProofRef = `${event.documentId}:${event.type}:${event.occurredAt}`
    const claim = await claimProviderEvent({
      demoRunId: document.demoRunId,
      provider: Provider.DOCUMENSO,
      externalEventId: receiptExternalEventId,
      eventType: event.sourceEventType,
      raw,
    })
    if (claim.status === 'DONE') return reply.code(200).send({ received: true, duplicate: true })
    if (claim.status === 'BUSY') throw httpError(503, 'Documenso event is already being processed; retry later')
    const response = await processProviderEventClaim(claim, async () => {
      if (event.type === 'OWNER_SIGNED') {
      if (!document.ownerSignedAt) {
        requireStage(document.opportunity.stage, [OpportunityStage.SIGNING], 'Owner signature')
        if (document.demoRun.status !== DemoRunStatus.AWAITING_OWNER_SIGNATURE) {
          throw new Error(`Owner signature is invalid while run is ${document.demoRun.status}`)
        }
      }
      await recordOwnerSignature(document.demoRunId)
      await db.document.updateMany({
        where: { id: document.id, demoRunId: document.demoRunId, opportunityId: document.opportunityId, ownerSignedAt: null },
        data: { ownerSignedAt: new Date(event.occurredAt), status: 'OWNER_SIGNED' },
      })
      await appendRunEventOnce(document.demoRunId, { opportunityId: document.opportunityId, type: 'owner.signed', status: 'SIGNING', summary: 'Owner action 2 completed in Documenso; awaiting the buyer role-player.', actor: 'owner-via-documenso', proofRef: effectProofRef })
      } else {
        const current = await db.document.findUniqueOrThrow({ where: { id: document.id } })
        if (!current.ownerSignedAt) throw new Error('Documenso completed before the required owner-first signature')
        if (current.ownerSignedAt >= new Date(event.occurredAt)) {
          throw new Error('Documenso completion does not follow the stored owner signature')
        }
      const stage = await currentOpportunityStage(document.opportunityId)
      requireStage(stage, [OpportunityStage.SIGNING, OpportunityStage.SIGNED], 'Document completion')
      if (document.demoRun.status !== DemoRunStatus.AWAITING_OWNER_SIGNATURE && document.demoRun.status !== DemoRunStatus.COMPLETE) {
        throw new Error(`Document completion is invalid while run is ${document.demoRun.status}`)
      }
      await db.document.updateMany({
        where: { id: document.id, demoRunId: document.demoRunId, opportunityId: document.opportunityId, completedAt: null },
        data: { buyerSignedAt: new Date(event.occurredAt), completedAt: new Date(event.occurredAt), status: 'COMPLETED' },
      })
      if (stage !== OpportunityStage.SIGNED) {
        await transitionOpportunity({ opportunityId: document.opportunityId, to: 'SIGNED', eventType: 'document.completed', summary: 'Buyer role-player signed second; Documenso marked the agreement complete.', actor: 'documenso', proofRef: effectProofRef })
      }
      await db.demoRun.updateMany({
        where: { id: document.demoRunId, status: { in: [DemoRunStatus.AWAITING_OWNER_SIGNATURE, DemoRunStatus.COMPLETE] } },
        data: { status: DemoRunStatus.COMPLETE, completedAt: new Date(event.occurredAt) },
      })
      }
      return { received: true, resumed: claim.status === 'RESUME' }
    })
    return reply.code(200).send(response)
  })

  app.post<{ Params: { id: string; slug: string } }>('/api/v1/demo-runs/:id/tasks/:slug', { preHandler: requireOwner }, async (request) => {
    if (!manualWorkflowTaskSlugs.includes(request.params.slug as ManualWorkflowTaskSlug)) throw httpError(400, 'Unknown workflow task')
    const slug = request.params.slug as ManualWorkflowTaskSlug
    const run = await db.demoRun.findUniqueOrThrow({
      where: { id: request.params.id },
      include: {
        workspace: { include: { pilotActivation: true } },
        approvals: { where: { kind: ApprovalKind.CAMPAIGN } },
        opportunities: {
          where: { company: { name: { in: ['Nordlicht Import GmbH', 'Maas Interiors BV'] } } },
          include: { company: true },
        },
      },
    })
    const opportunityStages = Object.fromEntries(
      run.opportunities.map((opportunity) => [opportunity.company.name, opportunity.stage]),
    ) as ManualTaskPhase['opportunityStages']
    assertProviderActionRunMode(run.mode)
    assertManualTaskPhase(slug, {
      runStatus: run.status,
      pilotStatus: run.workspace.pilotActivation?.status ?? null,
      campaignApproved: run.approvals.some((approval) => approval.decision === ApprovalDecision.APPROVE),
      opportunityStages,
    })
    const taskRunId = await triggerRenderTask(request.params.id, slug)
    return { taskRunId, snapshot: await getDemoRunSnapshot(request.params.id) }
  })
}
