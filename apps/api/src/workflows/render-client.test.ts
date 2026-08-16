import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: {
    demoRun: {
      findUniqueOrThrow: vi.fn(),
    },
    renderTaskIntent: {
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
    },
    workflowRun: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
  workflows: {
    startTask: vi.fn(),
    getTaskRun: vi.fn(),
    listTaskRuns: vi.fn(),
  },
  createProviderRegistry: vi.fn(() => new Map()),
  executeWorkflowTask: vi.fn(),
  hybridMode: false,
  Render: vi.fn(),
}))

vi.mock('../db.js', () => ({ db: mocks.db }))
vi.mock('../config.js', () => ({
  getConfig: () => ({
    RENDER_API_KEY: 'render-key',
    RENDER_OWNER_ID: 'owner-id',
    RENDER_WORKFLOW_SLUG: 'company-workflow',
    DEMO_HYBRID_MODE: mocks.hybridMode,
  }),
}))
vi.mock('@renderinc/sdk', () => ({
  Render: mocks.Render.mockImplementation(function Render() {
    return { workflows: mocks.workflows }
  }),
}))
vi.mock('./tasks.js', () => ({ executeWorkflowTask: mocks.executeWorkflowTask }))
vi.mock('../providers/registry.js', () => ({ createProviderRegistry: mocks.createProviderRegistry }))

import { reconcilePendingRenderTaskRuns, triggerRenderTask } from './render-client.js'

const plannedIntent = {
  id: 'intent-1',
  demoRunId: 'demo-1',
  taskSlug: 'discover-research-leads',
  externalId: null,
  triggerStatus: 'PLANNED',
  triggerAttempts: 0,
  triggerToken: null,
  lastError: null,
  leaseExpiresAt: null,
  createdAt: new Date('2026-08-15T00:00:00Z'),
  updatedAt: new Date('2026-08-15T00:00:00Z'),
}

describe('durable Render task intent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hybridMode = false
    mocks.db.demoRun.findUniqueOrThrow.mockResolvedValue({ workspace: { killSwitch: false } })
    mocks.db.renderTaskIntent.upsert.mockResolvedValue(plannedIntent)
    mocks.db.renderTaskIntent.update.mockResolvedValue(plannedIntent)
    mocks.db.renderTaskIntent.updateMany.mockResolvedValue({ count: 1 })
    mocks.db.workflowRun.upsert.mockResolvedValue({})
    mocks.db.workflowRun.updateMany.mockResolvedValue({ count: 1 })
    mocks.db.workflowRun.findMany.mockResolvedValue([])
    mocks.workflows.listTaskRuns.mockResolvedValue([])
    mocks.workflows.startTask.mockResolvedValue({ taskRunId: 'render-run-1' })
    mocks.executeWorkflowTask.mockResolvedValue(undefined)
  })

  it('creates the unique intent before starting the provider task', async () => {
    const order: string[] = []
    mocks.db.renderTaskIntent.upsert.mockImplementation(async () => {
      order.push('intent')
      return plannedIntent
    })
    mocks.workflows.startTask.mockImplementation(async () => {
      order.push('provider')
      return { taskRunId: 'render-run-1' }
    })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('render-run-1')

    expect(order).toEqual(['intent', 'provider'])
    expect(mocks.db.renderTaskIntent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { demoRunId_taskSlug: { demoRunId: 'demo-1', taskSlug: 'discover-research-leads' } },
    }))
    expect(mocks.db.demoRun.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'demo-1' },
      select: { workspace: { select: { killSwitch: true } } },
    })
    expect(mocks.workflows.startTask).toHaveBeenCalledTimes(1)
  })

  it('does not start a provider task when the workspace kill switch is enabled', async () => {
    mocks.db.demoRun.findUniqueOrThrow.mockResolvedValue({ workspace: { killSwitch: true } })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads'))
      .rejects.toThrow('Workspace kill switch prevents new Render task starts')

    expect(mocks.db.demoRun.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'demo-1' },
      select: { workspace: { select: { killSwitch: true } } },
    })
    expect(mocks.workflows.startTask).not.toHaveBeenCalled()
  })

  it('reuses and reconciles an existing provider run without starting another', async () => {
    mocks.db.renderTaskIntent.upsert.mockResolvedValue({ ...plannedIntent, externalId: 'render-existing' })
    mocks.workflows.getTaskRun.mockResolvedValue({
      id: 'render-existing',
      status: 'completed',
      input: ['demo-1'],
      attempts: [{}, {}],
    })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('render-existing')

    expect(mocks.db.demoRun.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(mocks.workflows.startTask).not.toHaveBeenCalled()
    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'RENDER',
        externalId: 'render-existing',
        status: { notIn: ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELED'] },
      },
      data: { status: 'COMPLETED', attempt: 2, retried: true },
    })
  })

  it('does not let a delayed nonterminal response overwrite a completed run', async () => {
    mocks.db.renderTaskIntent.upsert.mockResolvedValue({ ...plannedIntent, externalId: 'render-existing' })

    let resolveRunning!: (details: {
      id: string
      status: string
      input: string[]
      attempts: unknown[]
    }) => void
    const runningResponse = new Promise<{
      id: string
      status: string
      input: string[]
      attempts: unknown[]
    }>((resolve) => {
      resolveRunning = resolve
    })
    mocks.workflows.getTaskRun
      .mockReturnValueOnce(runningResponse)
      .mockResolvedValueOnce({
        id: 'render-existing',
        status: 'completed',
        input: ['demo-1'],
        attempts: [{}],
      })

    let storedStatus: string | undefined
    mocks.db.workflowRun.upsert.mockImplementation(async ({ create }) => {
      storedStatus ??= create.status
      return {}
    })
    mocks.db.workflowRun.updateMany.mockImplementation(async ({ where, data }) => {
      if (!storedStatus || where.status.notIn.includes(storedStatus)) return { count: 0 }
      storedStatus = data.status
      return { count: 1 }
    })

    const delayedRunning = triggerRenderTask('demo-1', 'discover-research-leads')
    const completed = triggerRenderTask('demo-1', 'discover-research-leads')
    await expect(completed).resolves.toBe('render-existing')

    resolveRunning({
      id: 'render-existing',
      status: 'running',
      input: ['demo-1'],
      attempts: [{}],
    })
    await expect(delayedRunning).resolves.toBe('render-existing')

    expect(storedStatus).toBe('COMPLETED')
  })

  it('keeps legacy terminal runs terminal during reconciliation', async () => {
    mocks.db.renderTaskIntent.findMany.mockResolvedValue([])
    mocks.db.workflowRun.findMany.mockResolvedValue([{
      demoRunId: 'demo-1',
      externalId: 'render-legacy',
      taskSlug: 'discover-research-leads',
    }])
    mocks.workflows.getTaskRun.mockResolvedValue({
      id: 'render-legacy',
      status: 'running',
      input: ['demo-1'],
      attempts: [{}],
    })

    await reconcilePendingRenderTaskRuns('demo-1')

    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'RENDER',
        externalId: 'render-legacy',
        status: { notIn: ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELED'] },
      },
      data: { status: 'RUNNING', attempt: 1, retried: false },
    })
  })

  it('persists a trigger failure with a retry delay so a later expired call can retry', async () => {
    mocks.workflows.startTask.mockRejectedValueOnce(new Error('Render unavailable'))

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).rejects.toThrow('Render unavailable')
    expect(mocks.db.renderTaskIntent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'intent-1', triggerToken: expect.any(String) }),
      data: expect.objectContaining({
        triggerStatus: 'FAILED',
        triggerToken: null,
        lastError: 'Render unavailable',
        leaseExpiresAt: expect.any(Date),
      }),
    }))

    mocks.db.renderTaskIntent.upsert.mockResolvedValue({
      ...plannedIntent,
      triggerStatus: 'FAILED',
      lastError: 'Render unavailable',
      leaseExpiresAt: new Date('2026-08-14T00:00:00Z'),
    })
    mocks.workflows.startTask.mockResolvedValueOnce({ taskRunId: 'render-retry' })
    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('render-retry')
    expect(mocks.workflows.startTask).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale claim overwrite the winning provider run', async () => {
    let staleToken: string | undefined
    mocks.db.renderTaskIntent.updateMany.mockImplementation(async (args) => {
      if (args.data.triggerStatus === 'TRIGGERING') {
        staleToken = args.data.triggerToken
        return { count: 1 }
      }
      if (args.data.externalId === 'render-run-1') return { count: 0 }
      return { count: 1 }
    })
    mocks.db.renderTaskIntent.findUniqueOrThrow.mockResolvedValue({
      ...plannedIntent,
      externalId: 'render-winner',
      triggerStatus: 'TRIGGERED',
    })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('render-winner')

    expect(mocks.workflows.startTask).toHaveBeenCalledTimes(1)
    expect(mocks.db.renderTaskIntent.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'intent-1', triggerToken: staleToken, externalId: null },
      data: expect.objectContaining({ externalId: 'render-run-1' }),
    }))
    expect(mocks.db.workflowRun.upsert).not.toHaveBeenCalled()
  })

  it('recovers an accepted provider run after an uncertain trigger outcome', async () => {
    mocks.workflows.listTaskRuns.mockResolvedValueOnce([
      { taskRun: { id: 'render-accepted', startedAt: '2026-08-15T00:00:01Z' } },
    ])
    mocks.workflows.getTaskRun.mockResolvedValue({
      id: 'render-accepted',
      status: 'running',
      input: ['demo-1'],
      attempts: [{}],
    })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('render-accepted')
    expect(mocks.workflows.startTask).not.toHaveBeenCalled()
  })

  it('executes hybrid tasks inline without constructing the Render SDK and records non-live proof', async () => {
    mocks.hybridMode = true

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('inline:intent-1')

    expect(mocks.Render).not.toHaveBeenCalled()
    expect(mocks.workflows.startTask).not.toHaveBeenCalled()
    expect(mocks.executeWorkflowTask).toHaveBeenCalledWith(
      'discover-research-leads',
      'demo-1',
      expect.any(Map),
    )
    expect(mocks.db.workflowRun.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        externalId: 'inline:intent-1',
        live: false,
        status: 'RUNNING',
      }),
    }))
    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ externalId: 'inline:intent-1' }),
      data: { status: 'COMPLETED' },
    }))
  })

  it('checks the workspace kill switch before hybrid inline execution', async () => {
    mocks.hybridMode = true
    mocks.db.demoRun.findUniqueOrThrow.mockResolvedValue({ workspace: { killSwitch: true } })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads'))
      .rejects.toThrow('Workspace kill switch prevents new Render task starts')

    expect(mocks.executeWorkflowTask).not.toHaveBeenCalled()
    expect(mocks.createProviderRegistry).not.toHaveBeenCalled()
  })

  it('fences duplicate hybrid triggers before workflow provider effects execute twice', async () => {
    mocks.hybridMode = true
    let externalId: string | null = null
    mocks.db.renderTaskIntent.upsert.mockImplementation(async () => ({ ...plannedIntent, externalId }))
    mocks.db.renderTaskIntent.updateMany.mockImplementation(async ({ data }) => {
      if (data.triggerStatus === 'TRIGGERING') return { count: externalId ? 0 : 1 }
      if (data.externalId) {
        externalId = data.externalId
        return { count: 1 }
      }
      return { count: 1 }
    })

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('inline:intent-1')
    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('inline:intent-1')

    expect(mocks.executeWorkflowTask).toHaveBeenCalledTimes(1)
  })

  it('runs a completed Band inline task once more and fences a concurrent repeat', async () => {
    mocks.hybridMode = true
    const externalId = 'inline:intent-1'
    let intent = {
      ...plannedIntent,
      taskSlug: 'run-band-negotiation',
      externalId,
      triggerStatus: 'TRIGGERED',
    }
    mocks.db.renderTaskIntent.upsert.mockImplementation(async () => ({ ...intent }))
    mocks.db.renderTaskIntent.updateMany.mockImplementation(async ({ where, data }) => {
      if (data.triggerStatus === 'TRIGGERING') {
        if (intent.triggerStatus !== 'TRIGGERED' || where.externalId !== externalId) return { count: 0 }
        intent = { ...intent, ...data }
        return { count: 1 }
      }
      if (where.triggerToken !== intent.triggerToken) return { count: 0 }
      intent = { ...intent, ...data }
      return { count: 1 }
    })
    mocks.db.renderTaskIntent.findUniqueOrThrow.mockImplementation(async () => ({ ...intent }))
    mocks.db.workflowRun.findUnique.mockResolvedValue({ status: 'COMPLETED' })

    let finishRepeat!: () => void
    mocks.executeWorkflowTask.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRepeat = resolve
    }))

    const repeat = triggerRenderTask('demo-1', 'run-band-negotiation')
    await vi.waitFor(() => expect(mocks.executeWorkflowTask).toHaveBeenCalledTimes(1))
    const concurrent = triggerRenderTask('demo-1', 'run-band-negotiation')
    await expect(concurrent).resolves.toBe(externalId)
    finishRepeat()
    await expect(repeat).resolves.toBe(externalId)

    expect(mocks.executeWorkflowTask).toHaveBeenCalledTimes(1)
    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { provider: 'RENDER', externalId, status: { in: ['COMPLETED'] } },
      data: { status: 'RUNNING', attempt: { increment: 1 }, retried: true },
    })
  })

  it('marks hybrid workflow proof failed when inline execution fails', async () => {
    mocks.hybridMode = true
    mocks.executeWorkflowTask.mockRejectedValueOnce(new Error('inline task failed'))

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).rejects.toThrow('inline task failed')

    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith({
      where: {
        provider: 'RENDER',
        externalId: 'inline:intent-1',
        status: { notIn: ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELED'] },
      },
      data: { status: 'FAILED' },
    })
  })

  it('retries a failed hybrid execution with the stable inline id and a new proof attempt', async () => {
    mocks.hybridMode = true
    mocks.db.renderTaskIntent.upsert
      .mockResolvedValueOnce(plannedIntent)
      .mockResolvedValueOnce({
        ...plannedIntent,
        externalId: 'inline:intent-1',
        triggerStatus: 'FAILED',
        lastError: 'first attempt failed',
      })
    mocks.executeWorkflowTask
      .mockRejectedValueOnce(new Error('first attempt failed'))
      .mockResolvedValueOnce(undefined)

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).rejects.toThrow('first attempt failed')
    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('inline:intent-1')

    expect(mocks.executeWorkflowTask).toHaveBeenCalledTimes(2)
    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { provider: 'RENDER', externalId: 'inline:intent-1', status: { in: ['FAILED', 'RUNNING'] } },
      data: { status: 'RUNNING', attempt: { increment: 1 }, retried: true },
    })
    expect(mocks.db.workflowRun.updateMany).toHaveBeenLastCalledWith({
      where: {
        provider: 'RENDER',
        externalId: 'inline:intent-1',
        status: { notIn: ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELED'] },
      },
      data: { status: 'COMPLETED' },
    })
  })

  it('reclaims an expired inline execution lease but not a fresh in-flight lease', async () => {
    mocks.hybridMode = true
    const stale = {
      ...plannedIntent,
      externalId: 'inline:intent-1',
      triggerStatus: 'TRIGGERING',
      triggerToken: 'abandoned-token',
      leaseExpiresAt: new Date('2020-01-01T00:00:00Z'),
    }
    mocks.db.renderTaskIntent.upsert.mockResolvedValueOnce(stale)

    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('inline:intent-1')
    expect(mocks.executeWorkflowTask).toHaveBeenCalledTimes(1)
    expect(mocks.db.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { provider: 'RENDER', externalId: 'inline:intent-1', status: { in: ['FAILED', 'RUNNING'] } },
      data: { status: 'RUNNING', attempt: { increment: 1 }, retried: true },
    })

    vi.clearAllMocks()
    mocks.db.renderTaskIntent.upsert.mockResolvedValue({
      ...stale,
      leaseExpiresAt: new Date('2999-01-01T00:00:00Z'),
    })
    await expect(triggerRenderTask('demo-1', 'discover-research-leads')).resolves.toBe('inline:intent-1')
    expect(mocks.executeWorkflowTask).not.toHaveBeenCalled()
  })
})
