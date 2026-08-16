import type { FastifyInstance } from 'fastify'
import { createDemoRunSchema, demoRunSnapshotSchema, ownerDecisionSchema } from '@zero-human/contracts'
import { ApprovalDecision, ApprovalKind, RunMode } from '@prisma/client'
import { requireOwner } from '../auth.js'
import { getConfig } from '../config.js'
import { db } from '../db.js'
import { collectProof, createDemoRun, decideCampaign, getDemoRunSnapshot, latestDemoRunId } from '../domain/demo-service.js'
import { FakeRehearsalConflictError, runFakeRehearsal } from '../domain/fake-run.js'
import { verifyDemoRun } from '../domain/verify.js'
import { httpError } from '../http-errors.js'
import { reconcilePendingRenderTaskRuns, triggerRenderTask } from '../workflows/render-client.js'

const approvedRenderTasks = [
  'discover-research-leads',
  'send-nordlicht-outreach',
  'prove-render-retry',
] as const

const publicReconciliationThrottleMs = 5_000

interface PublicReconciliationState {
  inFlight?: Promise<void>
  lastCompletedAt?: number
  cleanupTimer?: ReturnType<typeof setTimeout>
}

const publicReconciliations = new Map<string, PublicReconciliationState>()

function requiredRunMode(): RunMode {
  const config = getConfig()
  if (config.DEMO_HYBRID_MODE) return RunMode.FAKE
  return config.PROVIDER_MODE === 'real' ? RunMode.JUDGE : RunMode.FAKE
}

function assertActionRunMode(mode: RunMode): void {
  const expectedMode = requiredRunMode()
  if (mode !== expectedMode) {
    const message = expectedMode === RunMode.JUDGE
      ? 'Real provider actions require a JUDGE run'
      : 'This deployment only accepts FAKE runs'
    throw httpError(409, message)
  }
}

function reconcilePublicDemoRun(demoRunId: string): Promise<void> {
  let state = publicReconciliations.get(demoRunId)
  if (state?.inFlight) return state.inFlight
  if (state?.lastCompletedAt !== undefined && Date.now() - state.lastCompletedAt < publicReconciliationThrottleMs) {
    return Promise.resolve()
  }

  state ??= {}
  if (state.cleanupTimer) clearTimeout(state.cleanupTimer)

  const reconciliation = reconcilePendingRenderTaskRuns(demoRunId)
    .then(() => {
      state.lastCompletedAt = Date.now()
    })
    .finally(() => {
      state.inFlight = undefined
      if (state.lastCompletedAt === undefined) {
        publicReconciliations.delete(demoRunId)
        return
      }

      const remainingThrottleMs = Math.max(
        0,
        state.lastCompletedAt + publicReconciliationThrottleMs - Date.now(),
      )
      state.cleanupTimer = setTimeout(() => {
        if (publicReconciliations.get(demoRunId) === state && !state.inFlight) {
          publicReconciliations.delete(demoRunId)
        }
      }, remainingThrottleMs)
      state.cleanupTimer.unref?.()
    })

  state.inFlight = reconciliation
  publicReconciliations.set(demoRunId, state)
  return reconciliation
}

async function reconciledSnapshot(demoRunId: string) {
  await reconcilePublicDemoRun(demoRunId)
  return demoRunSnapshotSchema.parse(await getDemoRunSnapshot(demoRunId))
}

export function registerDemoRoutes(app: FastifyInstance): void {
  app.get('/api/v1/demo-runs/active', async (_request, reply) => {
    const id = await latestDemoRunId()
    if (!id) return reply.code(404).send({ error: 'No demo run exists yet' })
    return reconciledSnapshot(id)
  })

  app.get<{ Params: { id: string } }>('/api/v1/demo-runs/:id', async (request) => {
    return reconciledSnapshot(request.params.id)
  })

  app.get<{ Params: { id: string } }>('/api/v1/demo-runs/:id/proof', async (request) => {
    await reconcilePublicDemoRun(request.params.id)
    return {
      demoRunId: request.params.id,
      proof: await collectProof(request.params.id),
    }
  })

  app.get<{ Params: { id: string } }>('/api/v1/demo-runs/:id/verify', async (request) => {
    await reconcilePublicDemoRun(request.params.id)
    return verifyDemoRun(request.params.id)
  })

  app.get<{ Params: { id: string } }>('/api/v1/demo-runs/:id/events', async (request, reply) => {
    const initialSnapshot = await reconciledSnapshot(request.params.id)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const writeSnapshot = (snapshot: typeof initialSnapshot) => {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    }
    writeSnapshot(initialSnapshot)
    let closed = false
    let nextTick: ReturnType<typeof setTimeout> | undefined
    const scheduleNextTick = () => {
      nextTick = setTimeout(() => void send(), 1_500)
    }
    const send = async () => {
      try {
        const snapshot = await reconciledSnapshot(request.params.id)
        if (!closed) {
          writeSnapshot(snapshot)
          scheduleNextTick()
        }
      } catch {
        if (!closed) reply.raw.end()
      }
    }
    scheduleNextTick()
    request.raw.on('close', () => {
      closed = true
      if (nextTick) clearTimeout(nextTick)
    })
  })

  app.post('/api/v1/demo-runs', { preHandler: requireOwner }, async (request, reply) => {
    const input = createDemoRunSchema.parse(request.body ?? {})
    const expectedMode = requiredRunMode()
    if (input.mode !== expectedMode) {
      throw httpError(409, `This deployment only accepts ${expectedMode} runs`)
    }
    const id = await createDemoRun(input.mode)
    return reply.code(201).send(demoRunSnapshotSchema.parse(await getDemoRunSnapshot(id)))
  })

  app.post<{ Params: { id: string } }>('/api/v1/demo-runs/:id/rehearse', { preHandler: requireOwner }, async (request) => {
    if (getConfig().DEMO_HYBRID_MODE) {
      throw httpError(409, 'Fake rehearsal is unavailable in hybrid mode')
    }
    try {
      await runFakeRehearsal(request.params.id)
    } catch (error) {
      if (error instanceof FakeRehearsalConflictError) {
        throw httpError(409, error.message)
      }
      throw error
    }
    return demoRunSnapshotSchema.parse(await getDemoRunSnapshot(request.params.id))
  })

  app.post<{ Params: { id: string } }>('/api/v1/demo-runs/:id/campaign-decision', { preHandler: requireOwner }, async (request) => {
    const input = ownerDecisionSchema.parse(request.body)
    const run = await db.demoRun.findUniqueOrThrow({ where: { id: request.params.id }, select: { mode: true } })
    assertActionRunMode(run.mode)
    if (input.decision === 'APPROVE') {
      const approval = await db.approval.findUnique({
        where: { demoRunId_kind: { demoRunId: request.params.id, kind: ApprovalKind.CAMPAIGN } },
      })
      if (!approval) await decideCampaign(request.params.id, input.decision)
      else if (approval.decision !== ApprovalDecision.APPROVE) {
        throw httpError(409, 'Campaign was already rejected and cannot be approved on retry')
      }
      if (getConfig().PROVIDER_MODE === 'real' || getConfig().DEMO_HYBRID_MODE) {
        await Promise.all(approvedRenderTasks.map((slug) => triggerRenderTask(request.params.id, slug)))
      }
    } else {
      await decideCampaign(request.params.id, input.decision)
    }
    return reconciledSnapshot(request.params.id)
  })
}
