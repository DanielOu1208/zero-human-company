import { describe, expect, it } from 'vitest'
import { assertTransition, canTransition, toPipelineBucket } from './state-machine.js'
import { evaluatePricePolicy } from './policy.js'

describe('opportunity state machine', () => {
  it('allows only forward workflow transitions and terminal pauses', () => {
    expect(canTransition('ENGAGED', 'NEGOTIATING')).toBe(true)
    expect(canTransition('ENGAGED', 'SIGNED')).toBe(false)
    expect(canTransition('PAUSED', 'ENGAGED')).toBe(true)
    expect(() => assertTransition('PAUSED', 'OUTREACH')).toThrow(/Invalid/)
  })

  it('maps seven workflow stages to the four visual buckets', () => {
    expect(toPipelineBucket('RESEARCHING')).toBe('sourcing')
    expect(toPipelineBucket('ENGAGED')).toBe('contacted')
    expect(toPipelineBucket('NEGOTIATING')).toBe('negotiating')
    expect(toPipelineBucket('SIGNED')).toBe('contract')
  })
})

describe('price policy', () => {
  it('terminally pauses the Maas below-floor offer', () => {
    expect(evaluatePricePolicy({ offeredPrice: 150, floorPrice: 158, currency: 'EUR', unit: 'seat' }))
      .toMatchObject({ outcome: 'PAUSE', reason: 'POLICY_BELOW_FLOOR' })
  })
})
