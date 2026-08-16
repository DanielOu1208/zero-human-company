import { EventEmitter } from 'node:events'
import type { FastifyInstance } from 'fastify'
import { demoRunSnapshotSchema, type DemoRunSnapshot } from '@zero-human/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  collectProof: vi.fn(),
  createDemoRun: vi.fn(),
  decideCampaign: vi.fn(),
  findApproval: vi.fn(),
  findDemoRun: vi.fn(),
  getDemoRunSnapshot: vi.fn(),
  hybridMode: false,
  providerMode: 'fake',
  reconcilePendingRenderTaskRuns: vi.fn(),
  runFakeRehearsal: vi.fn(),
  triggerRenderTask: vi.fn(),
  verifyDemoRun: vi.fn(),
}))

vi.mock('../auth.js', () => ({ requireOwner: vi.fn() }))
vi.mock('../config.js', () => ({
  getConfig: () => ({ PROVIDER_MODE: mocks.providerMode, DEMO_HYBRID_MODE: mocks.hybridMode }),
}))
vi.mock('../db.js', () => ({
  db: {
    approval: { findUnique: mocks.findApproval },
    demoRun: { findUniqueOrThrow: mocks.findDemoRun },
  },
}))
vi.mock('../domain/demo-service.js', () => ({
  collectProof: mocks.collectProof,
  createDemoRun: mocks.createDemoRun,
  decideCampaign: mocks.decideCampaign,
  getDemoRunSnapshot: mocks.getDemoRunSnapshot,
  latestDemoRunId: vi.fn(),
}))
vi.mock('../domain/fake-run.js', () => ({
  FakeRehearsalConflictError: class FakeRehearsalConflictError extends Error {},
  runFakeRehearsal: mocks.runFakeRehearsal,
}))
vi.mock('../domain/verify.js', () => ({ verifyDemoRun: mocks.verifyDemoRun }))
vi.mock('../http-errors.js', () => ({
  httpError: (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode }),
}))
vi.mock('../workflows/render-client.js', () => ({
  reconcilePendingRenderTaskRuns: mocks.reconcilePendingRenderTaskRuns,
  triggerRenderTask: mocks.triggerRenderTask,
}))

import { registerDemoRoutes } from './demo.js'
import { FakeRehearsalConflictError } from '../domain/fake-run.js'

type TestRequest = {
  params: { id: string }
  body?: unknown
  raw: EventEmitter
}

type TestReply = {
  raw: {
    write: (chunk: string) => void
    writeHead: (status: number, headers: Record<string, string>) => void
    end: () => void
  }
  hijack: () => void
  code: (status: number) => TestReply
  send: (body: unknown) => unknown
}

type TestHandler = (request: TestRequest, reply: TestReply) => Promise<unknown>

const snapshot = (id: string): DemoRunSnapshot => ({
  id,
  status: 'RUNNING',
  mode: 'JUDGE',
  workspaceName: 'Zero Human Company',
  pilot: { status: 'PENDING', amount: 500, currency: 'usd', checkoutUrl: null },
  ownerActions: { used: 1, pending: null },
  opportunities: [],
  timeline: [],
  proof: [],
  updatedAt: '2026-08-15T20:00:00.000Z',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function registeredRoutes() {
  const routes = new Map<string, TestHandler>()
  const app = {
    get(path: string, optionsOrHandler: unknown, maybeHandler?: unknown) {
      routes.set(path, (maybeHandler ?? optionsOrHandler) as TestHandler)
    },
    post(path: string, _options: unknown, handler: unknown) {
      routes.set(path, handler as TestHandler)
    },
  }
  registerDemoRoutes(app as unknown as FastifyInstance)
  return routes
}

function request(id: string): TestRequest {
  return { params: { id }, raw: new EventEmitter() }
}

function reply(writes: string[] = []): TestReply {
  const testReply = {
    raw: {
      write: (chunk) => { writes.push(chunk) },
      writeHead: vi.fn(),
      end: vi.fn(),
    },
    hijack: vi.fn(),
    code: vi.fn(),
    send: vi.fn((body) => body),
  }
  testReply.code.mockReturnValue(testReply)
  return testReply
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hybridMode = false
  mocks.providerMode = 'fake'
  mocks.collectProof.mockResolvedValue([])
  mocks.createDemoRun.mockResolvedValue('created-run')
  mocks.decideCampaign.mockResolvedValue(undefined)
  mocks.findApproval.mockResolvedValue(null)
  mocks.findDemoRun.mockResolvedValue({ mode: 'FAKE' })
  mocks.verifyDemoRun.mockResolvedValue({ passed: true })
  mocks.getDemoRunSnapshot.mockImplementation(async (id: string) => snapshot(id))
  mocks.reconcilePendingRenderTaskRuns.mockResolvedValue(undefined)
  mocks.triggerRenderTask.mockResolvedValue('task-run')
})

describe('deployment run-mode gates', () => {
  it('requires JUDGE creation in real provider mode before creating a run', async () => {
    mocks.providerMode = 'real'
    const handler = registeredRoutes().get('/api/v1/demo-runs')!

    await expect(handler({ ...request(''), body: { mode: 'FAKE' } }, reply())).rejects.toMatchObject({
      statusCode: 409,
      message: 'This deployment only accepts JUDGE runs',
    })

    expect(mocks.createDemoRun).not.toHaveBeenCalled()
  })

  it('keeps matching create-run modes supported in fake and real deployments', async () => {
    const handler = registeredRoutes().get('/api/v1/demo-runs')!

    await handler({ ...request(''), body: { mode: 'FAKE' } }, reply())
    expect(mocks.createDemoRun).toHaveBeenLastCalledWith('FAKE')

    mocks.providerMode = 'real'
    await handler({ ...request(''), body: { mode: 'JUDGE' } }, reply())
    expect(mocks.createDemoRun).toHaveBeenLastCalledWith('JUDGE')
  })

  it('accepts only FAKE run creation in hybrid mode even when provider mode is real', async () => {
    mocks.hybridMode = true
    mocks.providerMode = 'real'
    const handler = registeredRoutes().get('/api/v1/demo-runs')!

    await handler({ ...request(''), body: { mode: 'FAKE' } }, reply())
    expect(mocks.createDemoRun).toHaveBeenCalledWith('FAKE')

    await expect(handler({ ...request(''), body: { mode: 'JUDGE' } }, reply())).rejects.toMatchObject({
      statusCode: 409,
      message: 'This deployment only accepts FAKE runs',
    })
  })

  it('forbids all-fake rehearsal in hybrid mode and preserves it in ordinary fake mode', async () => {
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/rehearse')!
    mocks.hybridMode = true

    await expect(handler(request('hybrid-run'), reply())).rejects.toMatchObject({
      statusCode: 409,
      message: 'Fake rehearsal is unavailable in hybrid mode',
    })
    expect(mocks.runFakeRehearsal).not.toHaveBeenCalled()

    mocks.hybridMode = false
    await handler(request('fake-run'), reply())
    expect(mocks.runFakeRehearsal).toHaveBeenCalledWith('fake-run')
  })

  it.each(['APPROVE', 'REJECT'] as const)('rejects a FAKE campaign %s in real mode before persistence or Render dispatch', async (decision) => {
    mocks.providerMode = 'real'
    mocks.findDemoRun.mockResolvedValueOnce({ mode: 'FAKE' })
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/campaign-decision')!

    await expect(handler({ ...request('fake-run'), body: { decision } }, reply())).rejects.toMatchObject({
      statusCode: 409,
      message: 'Real provider actions require a JUDGE run',
    })

    expect(mocks.findApproval).not.toHaveBeenCalled()
    expect(mocks.decideCampaign).not.toHaveBeenCalled()
    expect(mocks.triggerRenderTask).not.toHaveBeenCalled()
  })

  it('allows an approved JUDGE campaign to dispatch Render tasks in real mode', async () => {
    mocks.providerMode = 'real'
    mocks.findDemoRun.mockResolvedValueOnce({ mode: 'JUDGE' })
    mocks.findApproval.mockResolvedValueOnce({ decision: 'APPROVE' })
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/campaign-decision')!

    await handler({ ...request('judge-run'), body: { decision: 'APPROVE' } }, reply())

    expect(mocks.triggerRenderTask).toHaveBeenCalledTimes(3)
  })

  it('keeps FAKE campaign decisions local in fake mode', async () => {
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/campaign-decision')!

    await handler({ ...request('fake-run'), body: { decision: 'APPROVE' } }, reply())

    expect(mocks.decideCampaign).toHaveBeenCalledWith('fake-run', 'APPROVE')
    expect(mocks.triggerRenderTask).not.toHaveBeenCalled()
  })

  it('dispatches approved FAKE campaigns inline in hybrid mode and rejects JUDGE campaigns', async () => {
    mocks.hybridMode = true
    mocks.providerMode = 'real'
    mocks.findApproval.mockResolvedValue({ decision: 'APPROVE' })
    const handler = registeredRoutes().get('/api/v1/demo-runs/:id/campaign-decision')!

    await handler({ ...request('fake-run'), body: { decision: 'APPROVE' } }, reply())
    expect(mocks.triggerRenderTask).toHaveBeenCalledTimes(3)

    mocks.findDemoRun.mockResolvedValueOnce({ mode: 'JUDGE' })
    await expect(handler({ ...request('judge-run'), body: { decision: 'APPROVE' } }, reply())).rejects.toMatchObject({
      statusCode: 409,
      message: 'This deployment only accepts FAKE runs',
    })
  })
})

describe('public demo reconciliation', () => {
  it('single-flights concurrent snapshot, proof, verification, and SSE readers for one run', async () => {
    const routes = registeredRoutes()
    const reconciliation = deferred<void>()
    mocks.reconcilePendingRenderTaskRuns.mockReturnValueOnce(reconciliation.promise)
    const id = 'concurrent-public-run'
    const eventRequest = request(id)

    const responses = [
      routes.get('/api/v1/demo-runs/:id')!(request(id), reply()),
      routes.get('/api/v1/demo-runs/:id/proof')!(request(id), reply()),
      routes.get('/api/v1/demo-runs/:id/verify')!(request(id), reply()),
      routes.get('/api/v1/demo-runs/:id/events')!(eventRequest, reply()),
    ]

    expect(mocks.reconcilePendingRenderTaskRuns).toHaveBeenCalledTimes(1)
    reconciliation.resolve()
    await Promise.all(responses)

    expect(mocks.reconcilePendingRenderTaskRuns).toHaveBeenCalledTimes(1)
    expect(mocks.collectProof).toHaveBeenCalledWith(id)
    expect(mocks.verifyDemoRun).toHaveBeenCalledWith(id)
    eventRequest.raw.emit('close')
  })

  it('throttles follow-up readers for five seconds before reconciling again', async () => {
    vi.useFakeTimers()
    try {
      const routes = registeredRoutes()
      const id = 'throttled-public-run'

      await routes.get('/api/v1/demo-runs/:id')!(request(id), reply())
      await routes.get('/api/v1/demo-runs/:id/proof')!(request(id), reply())
      expect(mocks.reconcilePendingRenderTaskRuns).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(4_999)
      await routes.get('/api/v1/demo-runs/:id')!(request(id), reply())
      expect(mocks.reconcilePendingRenderTaskRuns).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      await routes.get('/api/v1/demo-runs/:id/verify')!(request(id), reply())
      expect(mocks.reconcilePendingRenderTaskRuns).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start another SSE tick until the current snapshot is complete', async () => {
    vi.useFakeTimers()
    try {
      const routes = registeredRoutes()
      const id = 'slow-sse-run'
      const slowSnapshot = deferred<DemoRunSnapshot>()
      let snapshotWork = 0
      let maxSnapshotWork = 0

      mocks.getDemoRunSnapshot.mockImplementationOnce(async () => snapshot(id))
      mocks.getDemoRunSnapshot.mockImplementationOnce(async () => {
        snapshotWork += 1
        maxSnapshotWork = Math.max(maxSnapshotWork, snapshotWork)
        return slowSnapshot.promise.finally(() => { snapshotWork -= 1 })
      })
      mocks.getDemoRunSnapshot.mockImplementation(async () => snapshot(id))

      const writes: string[] = []
      const eventRequest = request(id)
      await routes.get('/api/v1/demo-runs/:id/events')!(eventRequest, reply(writes))

      await vi.advanceTimersByTimeAsync(1_500)
      expect(snapshotWork).toBe(1)
      expect(mocks.getDemoRunSnapshot).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(6_000)
      expect(mocks.getDemoRunSnapshot).toHaveBeenCalledTimes(2)
      expect(maxSnapshotWork).toBe(1)

      slowSnapshot.resolve(snapshot(id))
      await vi.advanceTimersByTimeAsync(0)
      expect(writes).toHaveLength(2)

      const emittedSnapshot = JSON.parse(writes[1]!.split('data: ')[1]!.trim())
      expect(demoRunSnapshotSchema.parse(emittedSnapshot)).toEqual(snapshot(id))

      await vi.advanceTimersByTimeAsync(1_500)
      expect(mocks.getDemoRunSnapshot).toHaveBeenCalledTimes(3)
      eventRequest.raw.emit('close')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fake rehearsal route guard', () => {
  it('maps a rejected rehearsal target to HTTP 409 without reading a mutated snapshot', async () => {
    const routes = registeredRoutes()
    mocks.runFakeRehearsal.mockRejectedValueOnce(new FakeRehearsalConflictError('not a fresh FAKE run'))

    await expect(
      routes.get('/api/v1/demo-runs/:id/rehearse')!(request('judge-run'), reply()),
    ).rejects.toMatchObject({ statusCode: 409 })

    expect(mocks.getDemoRunSnapshot).not.toHaveBeenCalled()
  })
})
