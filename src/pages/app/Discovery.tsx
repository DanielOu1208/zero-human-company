import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useDemo } from '../../state/DemoContext'

const EASE = [0.16, 1, 0.3, 1] as const
const spring = { type: 'spring' as const, stiffness: 330, damping: 28 }
const SOURCE_MS = 950

const SOURCES = [
  { label: 'LinkedIn', found: 11 },
  { label: 'Maps', found: 8 },
  { label: 'Customs filings', found: 14 },
  { label: 'Trade directories', found: 7 },
  { label: 'Showrooms', found: 9 },
] as const

const FOUND_TOTAL = SOURCES.reduce((sum, source) => sum + source.found, 0)

type Phase = 'idle' | 'scanning' | 'done'

export function Discovery() {
  const { startDiscovery, discoveryRemaining, runtimeRun, apiConnected, runtimeError } = useDemo()
  const reduceMotion = Boolean(useReducedMotion())
  const [phase, setPhase] = useState<Phase>('idle')
  const [activeIndex, setActiveIndex] = useState(0)
  const [lastAdded, setLastAdded] = useState<number | null>(null)
  const finishRef = useRef(startDiscovery)
  finishRef.current = startDiscovery

  const scanning = phase === 'scanning'
  const canStart = !apiConnected && !scanning && discoveryRemaining > 0
  const found = SOURCES.slice(0, Math.min(activeIndex, SOURCES.length)).reduce(
    (sum, source) => sum + source.found,
    0,
  )
  const researchCandidates = runtimeRun?.opportunities.filter(
    (opportunity) => opportunity.researchOnly,
  ) ?? []

  const finishRound = () => {
    const added = finishRef.current()
    setLastAdded(added)
    setActiveIndex(SOURCES.length)
    setPhase('done')
  }

  useEffect(() => {
    if (phase !== 'scanning') return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const run = (index: number) => {
      if (cancelled) return
      setActiveIndex(index)
      if (index >= SOURCES.length) {
        timer = setTimeout(() => {
          if (!cancelled) finishRound()
        }, 280)
        return
      }
      timer = setTimeout(() => run(index + 1), SOURCE_MS)
    }

    run(0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [phase])

  const onStart = () => {
    if (!canStart) return
    setLastAdded(null)
    if (reduceMotion) {
      finishRound()
      return
    }
    setActiveIndex(0)
    setPhase('scanning')
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-ink">Discovery</h1>
      <p className="mt-1 text-sm text-muted">
        {apiConnected
          ? 'Discovery is controlled by the persisted workflow.'
          : runtimeError
            ? 'Offline · local preview with fixture buyers.'
            : 'Local preview animation · add fixture buyers to the Pipeline.'}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart}
          className={`cursor-pointer rounded-lg border-0 px-4 py-2.5 text-sm font-medium transition-colors ${
            canStart
              ? 'bg-accent text-white hover:bg-accent/90'
              : 'cursor-not-allowed bg-hover text-faint'
          }`}
        >
          {scanning
            ? 'Scanning…'
            : apiConnected
              ? 'Managed by persisted workflow'
            : discoveryRemaining === 0 && lastAdded !== null
              ? `Round complete · ${lastAdded} added`
              : 'Start new round'}
        </button>
        {phase === 'done' && lastAdded !== null && discoveryRemaining > 0 ? (
          <p className="text-sm text-muted">Round complete · {lastAdded} added</p>
        ) : null}
        {discoveryRemaining === 0 && lastAdded !== null ? (
          <p className="text-xs text-faint">No more rounds in this demo.</p>
        ) : null}
      </div>

      <AnimatePresence>
        {apiConnected || phase !== 'idle' ? (
          <motion.div
            initial={apiConnected || reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.35, ease: EASE }}
            className="mt-6 max-w-lg rounded-xl border border-black/8 bg-bg px-4 py-4"
          >
            {apiConnected ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-ink">Persisted research candidates</p>
                  <span className="text-sm font-medium tabular-nums text-ink">
                    {researchCandidates.length}
                  </span>
                </div>

                <div className="mt-4 space-y-3">
                  {researchCandidates.map((candidate) => (
                    <div key={candidate.id} className="border-t border-line pt-3 first:border-0 first:pt-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm text-ink">{candidate.company}</p>
                        <span className="text-[0.65rem] font-medium text-good">Research only</span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {[candidate.city, candidate.country].filter(Boolean).join(', ')}
                      </p>
                      <p className="mt-1 text-xs text-faint">{candidate.focus}</p>
                    </div>
                  ))}
                  {researchCandidates.length === 0 ? (
                    <p className="text-sm text-muted">No persisted research candidates.</p>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="space-y-3">
                  {SOURCES.map((source, index) => {
                    const done = index < activeIndex
                    const current = scanning && index === activeIndex
                    return (
                      <div key={source.label}>
                        <div className="flex items-baseline justify-between gap-3">
                          <p
                            className={`text-sm ${
                              done || current ? 'text-ink' : 'text-faint'
                            }`}
                          >
                            {source.label}
                          </p>
                          {done ? (
                            <span className="text-[0.65rem] font-medium text-good">Done</span>
                          ) : current ? (
                            <span className="text-[0.65rem] text-muted">Scanning</span>
                          ) : null}
                        </div>
                        <div className="relative mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                          <motion.div
                            className="h-full rounded-full bg-accent"
                            initial={false}
                            animate={{ width: done || (current && reduceMotion) ? '100%' : current ? '100%' : '0%' }}
                            transition={
                              current && !reduceMotion
                                ? { duration: SOURCE_MS / 1000, ease: EASE }
                                : { duration: 0 }
                            }
                          />
                          {current && !reduceMotion ? (
                            <motion.div
                              className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/80 to-transparent"
                              animate={{ x: ['-120%', '320%'] }}
                              transition={{ duration: 0.85, repeat: Infinity, ease: 'linear' }}
                            />
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                </div>

                <p className="mt-4 text-sm text-ink">
                  found{' '}
                  <motion.span
                    key={found}
                    initial={reduceMotion ? false : { opacity: 0.4 }}
                    animate={{ opacity: 1 }}
                    transition={spring}
                    className="font-medium tabular-nums"
                  >
                    {phase === 'done' ? FOUND_TOTAL : found}
                  </motion.span>{' '}
                  candidates
                </p>

                {phase === 'done' && lastAdded !== null ? (
                  <motion.p
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={reduceMotion ? { duration: 0 } : { duration: 0.35, ease: EASE }}
                    className="mt-2 text-sm text-ink"
                  >
                    {lastAdded} new buyers added to{' '}
                    <Link to="/app/buyers" className="text-accent no-underline hover:underline">
                      Pipeline
                    </Link>
                  </motion.p>
                ) : null}
              </>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
