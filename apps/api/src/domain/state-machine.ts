import type { OpportunityStage } from '@zero-human/contracts'

const transitions: Record<OpportunityStage, readonly OpportunityStage[]> = {
  RESEARCHING: ['OUTREACH', 'PAUSED', 'LOST'],
  OUTREACH: ['ENGAGED', 'PAUSED', 'LOST'],
  ENGAGED: ['NEGOTIATING', 'PAUSED', 'LOST'],
  NEGOTIATING: ['AGREEMENT', 'PAUSED', 'LOST'],
  AGREEMENT: ['SIGNING', 'PAUSED', 'LOST'],
  SIGNING: ['SIGNED', 'PAUSED', 'LOST'],
  SIGNED: [],
  PAUSED: ['ENGAGED'],
  LOST: [],
}

export function canTransition(from: OpportunityStage, to: OpportunityStage): boolean {
  return transitions[from].includes(to)
}

export function assertTransition(from: OpportunityStage, to: OpportunityStage): void {
  if (!canTransition(from, to)) throw new Error(`Invalid opportunity transition: ${from} -> ${to}`)
}

export type PipelineBucket = 'sourcing' | 'contacted' | 'negotiating' | 'contract'

export function toPipelineBucket(stage: OpportunityStage): PipelineBucket {
  if (stage === 'RESEARCHING') return 'sourcing'
  if (stage === 'OUTREACH' || stage === 'ENGAGED') return 'contacted'
  if (stage === 'NEGOTIATING') return 'negotiating'
  return 'contract'
}
