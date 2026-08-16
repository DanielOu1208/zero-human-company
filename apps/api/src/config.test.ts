import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./env.js', () => ({}))

const authKeys = ['COOKIE_SECRET', 'OWNER_EMAIL', 'OWNER_PASSWORD'] as const
const demoModeKeys = [
  'JUDGE_MODE',
  'DEMO_HYBRID_MODE',
  'PROVIDER_MODE',
  'REAL_ACTIONS_ENABLED',
] as const
const originalEnv = Object.fromEntries(
  ['NODE_ENV', ...authKeys, ...demoModeKeys].map((key) => [key, process.env[key]]),
)

async function readConfig() {
  vi.resetModules()
  const { getConfig } = await import('./config.js')
  return getConfig()
}

beforeEach(() => {
  process.env.NODE_ENV = 'production'
  delete process.env.COOKIE_SECRET
  delete process.env.OWNER_EMAIL
  delete process.env.OWNER_PASSWORD
  delete process.env.JUDGE_MODE
  delete process.env.DEMO_HYBRID_MODE
  delete process.env.PROVIDER_MODE
  delete process.env.REAL_ACTIONS_ENABLED
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('production owner authentication configuration', () => {
  it('keeps local authentication defaults available in development', async () => {
    process.env.NODE_ENV = 'development'

    await expect(readConfig()).resolves.toMatchObject({
      COOKIE_SECRET: 'local-only-cookie-secret-change-me',
      OWNER_EMAIL: 'owner@example.com',
      OWNER_PASSWORD: 'local-owner-password',
    })
  })

  it('rejects missing production credentials instead of using local defaults', async () => {
    await expect(readConfig()).rejects.toThrow(/COOKIE_SECRET must be explicitly configured/)
  })

  it.each([
    ['COOKIE_SECRET', 'local-only-cookie-secret-change-me'],
    ['COOKIE_SECRET', 'replace-with-at-least-32-random-characters'],
    ['OWNER_EMAIL', 'owner@example.com'],
    ['OWNER_PASSWORD', 'local-owner-password'],
    ['OWNER_PASSWORD', 'replace-me'],
  ] as const)('rejects the local %s default in production', async (key, localDefault) => {
    process.env.COOKIE_SECRET = 'production-cookie-secret-at-least-32-characters'
    process.env.OWNER_EMAIL = 'production-owner@example.test'
    process.env.OWNER_PASSWORD = 'production-owner-password'
    process.env[key] = localDefault

    await expect(readConfig()).rejects.toThrow(new RegExp(`${key} must be explicitly configured`))
  })
})

describe('hybrid demo configuration', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development'
    process.env.DEMO_HYBRID_MODE = 'true'
    process.env.JUDGE_MODE = 'false'
    process.env.PROVIDER_MODE = 'real'
    process.env.REAL_ACTIONS_ENABLED = 'true'
  })

  it('accepts an explicitly configured hybrid demo', async () => {
    await expect(readConfig()).resolves.toMatchObject({
      DEMO_HYBRID_MODE: true,
      JUDGE_MODE: false,
      PROVIDER_MODE: 'real',
      REAL_ACTIONS_ENABLED: true,
    })
  })

  it('rejects hybrid mode when judge mode is enabled', async () => {
    process.env.JUDGE_MODE = 'true'

    await expect(readConfig()).rejects.toThrow(/DEMO_HYBRID_MODE must be false when JUDGE_MODE=true/)
  })

  it('rejects hybrid mode with fake providers', async () => {
    process.env.PROVIDER_MODE = 'fake'

    await expect(readConfig()).rejects.toThrow(/DEMO_HYBRID_MODE requires PROVIDER_MODE=real/)
  })

  it('rejects hybrid mode when real actions are disabled', async () => {
    process.env.REAL_ACTIONS_ENABLED = 'false'

    await expect(readConfig()).rejects.toThrow(/DEMO_HYBRID_MODE requires REAL_ACTIONS_ENABLED=true/)
  })
})
