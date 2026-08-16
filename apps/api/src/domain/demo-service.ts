import { createHash } from 'node:crypto'
import type { DemoRunSnapshot, OpportunityStage, ProofItem } from '@zero-human/contracts'
import {
  ApprovalDecision,
  ApprovalKind,
  DemoRunStatus,
  OpportunityStage as DbOpportunityStage,
  PilotStatus,
  Prisma,
  Provider,
  RevisionStatus,
  RunMode,
} from '@prisma/client'
import { db } from '../db.js'
import { httpError } from '../http-errors.js'
import { getConfig } from '../config.js'
import { assertTransition } from './state-machine.js'
import { evaluatePricePolicy } from './policy.js'
import { sanitizeEventSummary } from './sanitize.js'

const campaignContent = {
  baseline: {
    subject: 'Furniture supply inquiry',
    body: 'We manufacture furniture. Please review our catalog.',
  },
  candidateA: {
    subject: 'A lower-risk first container for your sofa range',
    body: 'A focused offer with an inspection plan, FSC documentation, and a small first commitment.',
  },
  candidateB: {
    subject: 'Hengxin Home: bouclé sofa pilot for northern Europe',
    body: 'A direct, evidence-led pilot proposal with lead times, quality controls, and a clear next step.',
  },
} satisfies Record<string, Prisma.InputJsonValue>

const seededCompanies = [
  { key: 'nordlicht', name: 'Nordlicht Import GmbH', city: 'Hamburg', country: 'Germany', focus: 'Upholstered sofas, FSC Mix', contact: 'Anja Keller', title: 'Head of Sourcing', rolePlayer: true },
  { key: 'maas', name: 'Maas Interiors BV', city: 'Rotterdam', country: 'Netherlands', focus: 'Dining sets', contact: 'Bram Visser', title: 'Buyer', rolePlayer: true },
  { key: 'atelier', name: 'Atelier Loire', city: 'Nantes', country: 'France', focus: 'Oak dining and chairs', contact: null, title: null, rolePlayer: false },
  { key: 'fjord', name: 'Fjord Home AS', city: 'Bergen', country: 'Norway', focus: 'Bedroom furniture', contact: null, title: null, rolePlayer: false },
  { key: 'havn', name: 'Havn Living', city: 'Copenhagen', country: 'Denmark', focus: 'Sofas', contact: null, title: null, rolePlayer: false },
] as const

function addressHash(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined
}

export async function createDemoRun(mode: 'FAKE' | 'JUDGE' = 'FAKE'): Promise<string> {
  const config = getConfig()
  if (mode === 'JUDGE' && !config.JUDGE_MODE) throw new Error('JUDGE run requires JUDGE_MODE=true')

  return db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: 'Hengxin Home',
        ownerEmail: config.OWNER_EMAIL,
        pilotActivation: { create: { amount: 500, currency: 'usd' } },
      },
      include: { pilotActivation: true },
    })
    const campaign = await tx.campaign.create({
      data: { workspaceId: workspace.id, name: 'Northern Europe sofa pilot' },
    })
    await tx.campaignRevision.createMany({
      data: [
        { campaignId: campaign.id, label: 'Baseline', body: campaignContent.baseline, status: RevisionStatus.UNDER_STUDY },
        { campaignId: campaign.id, label: 'Candidate A', body: campaignContent.candidateA, status: RevisionStatus.UNDER_STUDY },
        { campaignId: campaign.id, label: 'Candidate B', body: campaignContent.candidateB, status: RevisionStatus.UNDER_STUDY },
      ],
    })
    const run = await tx.demoRun.create({
      data: {
        workspaceId: workspace.id,
        campaignId: campaign.id,
        mode: mode === 'JUDGE' ? RunMode.JUDGE : RunMode.FAKE,
        status: DemoRunStatus.AWAITING_PAYMENT,
      },
    })

    for (const company of seededCompanies) {
      const recipient = company.key === 'nordlicht'
        ? config.LINQ_NORDLICHT_RECIPIENT
        : company.key === 'maas'
          ? config.LINQ_MAAS_RECIPIENT
          : undefined
      const created = await tx.company.create({
        data: {
          demoRunId: run.id,
          name: company.name,
          city: company.city,
          country: company.country,
          focus: company.focus,
          researchOnly: !company.rolePlayer,
          contacts: company.contact ? {
            create: {
              name: company.contact,
              title: company.title,
              channel: 'LINQ',
              addressHash: addressHash(recipient),
              consented: Boolean(recipient),
              rolePlayer: company.rolePlayer,
            },
          } : undefined,
        },
        include: { contacts: true },
      })
      await tx.opportunity.create({
        data: {
          demoRunId: run.id,
          campaignId: campaign.id,
          companyId: created.id,
          contactId: created.contacts[0]?.id,
          stage: DbOpportunityStage.RESEARCHING,
        },
      })
    }
    await tx.event.create({
      data: {
        demoRunId: run.id,
        sequence: 1,
        type: 'demo.created',
        status: 'AWAITING_PAYMENT',
        summary: 'Demo run created; the $5 Stripe sandbox pilot activation is the first gate.',
        actor: 'system',
      },
    })
    return run.id
  })
}

export async function appendRunEvent(
  demoRunId: string,
  event: Omit<Prisma.EventUncheckedCreateInput, 'demoRunId' | 'sequence'>,
): Promise<void> {
  await db.$transaction(async (tx) => {
    if (event.opportunityId) {
      const opportunity = await tx.opportunity.findUniqueOrThrow({ where: { id: event.opportunityId } })
      if (opportunity.demoRunId !== demoRunId) throw new Error('Event opportunity does not belong to the demo run')
      const nextOpportunitySequence = opportunity.sequence + 1
      const updated = await tx.opportunity.updateMany({
        where: { id: opportunity.id, version: opportunity.version },
        data: { sequence: nextOpportunitySequence, version: { increment: 1 } },
      })
      if (updated.count !== 1) throw new Error('Opportunity changed concurrently; retry from fresh state')
      await tx.event.create({
        data: { ...event, summary: sanitizeEventSummary(event.summary), demoRunId, sequence: 0 },
      })
      return
    }
    await tx.event.create({
      data: { ...event, summary: sanitizeEventSummary(event.summary), demoRunId, sequence: 0 },
    })
  })
}

export async function transitionOpportunity(input: {
  opportunityId: string
  to: OpportunityStage
  reason?: string | null
  eventType: string
  summary: string
  actor: string
  proofRef?: string
  action?: { provider: Provider; kind: string; idempotencyKey: string; request: Prisma.InputJsonValue }
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const current = await tx.opportunity.findUniqueOrThrow({ where: { id: input.opportunityId } })
    assertTransition(current.stage as OpportunityStage, input.to)
    const nextOpportunitySequence = current.sequence + 1
    const updated = await tx.opportunity.updateMany({
      where: { id: current.id, version: current.version },
      data: {
        stage: input.to as DbOpportunityStage,
        stageReason: input.reason,
        version: { increment: 1 },
        sequence: nextOpportunitySequence,
      },
    })
    if (updated.count !== 1) throw new Error('Opportunity changed concurrently; retry from fresh state')
    await tx.event.create({
      data: {
        demoRunId: current.demoRunId,
        opportunityId: current.id,
        sequence: 0,
        type: input.eventType,
        status: input.to,
        summary: sanitizeEventSummary(input.summary),
        actor: input.actor,
        proofRef: input.proofRef,
      },
    })
    if (input.action) {
      await tx.providerAction.create({
        data: {
          demoRunId: current.demoRunId,
          provider: input.action.provider,
          kind: input.action.kind,
          idempotencyKey: input.action.idempotencyKey,
          request: input.action.request,
        },
      })
    }
  })
}

export async function decideCampaign(
  demoRunId: string,
  decision: 'APPROVE' | 'REJECT',
): Promise<void> {
  await db.$transaction(async (tx) => {
    const run = await tx.demoRun.findUniqueOrThrow({
      where: { id: demoRunId },
      include: { workspace: { include: { pilotActivation: true } }, humanStudies: true },
    })
    if (run.status !== DemoRunStatus.AWAITING_CAMPAIGN_APPROVAL) {
      throw httpError(409, 'Campaign is not awaiting owner approval')
    }
    if (run.workspace.pilotActivation?.status !== PilotStatus.PAID) throw httpError(409, 'Pilot is not paid')
    const study = run.humanStudies.find((item) => item.status === 'COMPLETE')
    if (!study) throw httpError(409, 'Terac study has not completed')
    await tx.approval.create({
      data: {
        demoRunId,
        kind: ApprovalKind.CAMPAIGN,
        decision: decision === 'APPROVE' ? ApprovalDecision.APPROVE : ApprovalDecision.REJECT,
        actor: 'owner',
      },
    })
    if (decision === 'REJECT') {
      await tx.demoRun.update({ where: { id: demoRunId }, data: { status: DemoRunStatus.PAUSED } })
      return
    }
    await tx.campaignRevision.updateMany({
      where: { campaignId: run.campaignId, status: RevisionStatus.UNDER_STUDY },
      data: { status: RevisionStatus.SUPERSEDED },
    })
    await tx.campaignRevision.update({
      where: { id: study.selectedRevisionId },
      data: { status: RevisionStatus.ACTIVE, activeFor: { connect: { id: run.campaignId } } },
    })
    await tx.demoRun.update({
      where: { id: demoRunId },
      data: { status: DemoRunStatus.RUNNING, startedAt: new Date() },
    })
  })
  await appendRunEvent(demoRunId, {
    type: 'campaign.approved',
    status: 'RUNNING',
    summary: getConfig().DEMO_HYBRID_MODE
      ? 'Owner approved the mock demo-selected campaign revision. Connected provider work may begin.'
      : 'Owner approved the human-selected campaign revision. Autonomous work may begin.',
    actor: 'owner',
  })
}

export async function recordOwnerSignature(demoRunId: string): Promise<void> {
  await db.approval.upsert({
    where: { demoRunId_kind: { demoRunId, kind: ApprovalKind.OWNER_SIGNATURE } },
    create: {
      demoRunId,
      kind: ApprovalKind.OWNER_SIGNATURE,
      decision: ApprovalDecision.APPROVE,
      actor: 'owner-via-documenso',
    },
    update: {},
  })
}

export async function applyMaasPolicyBranch(demoRunId: string): Promise<void> {
  const opportunity = await db.opportunity.findFirstOrThrow({
    where: { demoRunId, company: { name: 'Maas Interiors BV' } },
  })
  const decision = evaluatePricePolicy({ offeredPrice: 150, floorPrice: 158, currency: 'EUR', unit: 'seat' })
  if (decision.outcome !== 'PAUSE') throw new Error('Expected the below-floor fixture to pause')
  await transitionOpportunity({
    opportunityId: opportunity.id,
    to: 'PAUSED',
    reason: decision.reason,
    eventType: 'policy.blocked',
    summary: `${decision.summary}; no reply was sent.`,
    actor: 'policy-engine',
  })
}

export async function collectProof(demoRunId: string): Promise<ProofItem[]> {
  const run = await db.demoRun.findUniqueOrThrow({
    where: { id: demoRunId },
    include: {
      payments: true,
      humanStudies: true,
      messages: true,
      agentHandoffs: true,
      workflowRuns: true,
      documents: true,
      companies: true,
      providerActions: { where: { status: 'SUCCEEDED', providerExternalId: { not: null } } },
    },
  })
  const items: ProofItem[] = []
  for (const item of run.payments) if (item.stripeEventId) items.push({ provider: 'STRIPE', kind: 'pilot-payment', externalId: item.stripeEventId, live: item.providerMode !== 'FAKE', status: item.status, occurredAt: item.occurredAt.toISOString(), detail: `${item.providerMode} · ${item.amount} ${item.currency}` })
  for (const item of run.humanStudies) items.push({ provider: 'TERAC', kind: 'comparative-study', externalId: item.externalId, live: item.live, status: item.status, occurredAt: item.occurredAt.toISOString(), detail: `delta ${item.scoreDelta.toFixed(2)}` })
  for (const item of run.messages) if (item.externalId) items.push({ provider: 'LINQ', kind: `message-${item.direction.toLowerCase()}`, externalId: item.externalId, live: item.live, status: item.status, occurredAt: item.occurredAt.toISOString() })
  for (const item of run.agentHandoffs) items.push({ provider: 'BAND', kind: 'negotiation-handoff', externalId: item.roomId, live: item.live, status: item.status, occurredAt: item.occurredAt.toISOString() })
  for (const item of run.workflowRuns) items.push({ provider: 'RENDER', kind: item.taskSlug, externalId: item.externalId, live: item.live, status: item.status, occurredAt: item.occurredAt.toISOString(), detail: item.retried ? `retry proved on attempt ${item.attempt}` : `attempt ${item.attempt}` })
  for (const item of run.documents) items.push({ provider: 'DOCUMENSO', kind: 'sequential-envelope', externalId: item.externalId, live: item.live, status: item.status, occurredAt: item.occurredAt.toISOString() })
  for (const item of run.companies) if (item.monidProviderId) items.push({ provider: 'MONID', kind: 'company-discovery', externalId: item.monidProviderId, live: item.monidLive, status: 'COMPLETE', occurredAt: item.createdAt.toISOString(), detail: 'research-only' })
  for (const item of run.providerActions) {
    if (!item.providerExternalId) continue
    const storedResponse = item.redactedResponse && typeof item.redactedResponse === 'object' && !Array.isArray(item.redactedResponse)
      ? item.redactedResponse as Record<string, unknown>
      : null
    const response = storedResponse?.summary && typeof storedResponse.summary === 'object' && !Array.isArray(storedResponse.summary)
      ? storedResponse.summary as Record<string, unknown>
      : storedResponse
    const detail = item.provider === Provider.BAND
      ? `${String(response?.runtime ?? 'runtime unproven')} · ${String(response?.model ?? 'model unproven')} · external agents`
      : undefined
    items.push({
      provider: item.provider,
      kind: item.kind,
      externalId: item.providerExternalId,
      live: item.live,
      status: item.status,
      occurredAt: item.updatedAt.toISOString(),
      ...(detail ? { detail } : {}),
    })
  }
  return items.map((item) => ({
    ...item,
    kind: sanitizeEventSummary(item.kind, 120),
    externalId: sanitizeEventSummary(item.externalId, 240),
    status: sanitizeEventSummary(item.status, 80),
    ...(item.detail ? { detail: sanitizeEventSummary(item.detail, 240) } : {}),
  })).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
}

export async function getDemoRunSnapshot(demoRunId: string): Promise<DemoRunSnapshot> {
  const run = await db.demoRun.findUniqueOrThrow({
    where: { id: demoRunId },
    include: {
      workspace: { include: { pilotActivation: true } },
      opportunities: { include: { company: true, contact: true }, orderBy: { createdAt: 'asc' } },
      events: { orderBy: { sequence: 'desc' }, take: 100 },
      approvals: true,
    },
  })
  const pilot = run.workspace.pilotActivation
  if (!pilot) throw new Error('Run has no pilot activation')
  const pending = run.status === DemoRunStatus.AWAITING_CAMPAIGN_APPROVAL
    ? 'CAMPAIGN_APPROVAL'
    : run.status === DemoRunStatus.AWAITING_OWNER_SIGNATURE
      ? 'OWNER_SIGNATURE'
      : null
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    workspaceName: run.workspace.name,
    pilot: { status: pilot.status, amount: pilot.amount, currency: pilot.currency, checkoutUrl: null },
    ownerActions: { used: run.approvals.length, pending },
    opportunities: run.opportunities.map((item) => ({
      id: item.id,
      company: item.company.name,
      contactName: item.contact?.name ?? 'Research only',
      city: item.company.city,
      country: item.company.country,
      focus: item.company.focus,
      researchOnly: item.company.researchOnly,
      stage: item.stage,
      stageReason: item.stageReason,
      updatedAt: item.updatedAt.toISOString(),
    })),
    timeline: run.events.map((item) => ({
      sequence: item.sequence,
      type: item.type,
      status: item.status,
      summary: sanitizeEventSummary(item.summary),
      actor: item.actor,
      occurredAt: item.occurredAt.toISOString(),
      proofRef: item.proofRef,
    })),
    proof: await collectProof(demoRunId),
    updatedAt: run.updatedAt.toISOString(),
  }
}

export async function latestDemoRunId(): Promise<string | null> {
  return (await db.demoRun.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true } }))?.id ?? null
}
