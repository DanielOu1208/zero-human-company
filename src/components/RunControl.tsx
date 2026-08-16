import { useEffect, useState } from 'react'
import { getOwnerSession, logoutOwner, verifyRun, type VerificationReport } from '../api/runtime'
import { useDemo } from '../state/DemoContext'

const providerLabels = ['STRIPE', 'TERAC', 'MONID', 'LINQ', 'BAND', 'RENDER', 'DOCUMENSO', 'OPENAI'] as const

function runBadgeLabel(mode: 'FAKE' | 'JUDGE', status: string, hybrid: boolean): string {
  if (hybrid) return 'HYBRID DEMO'
  if (mode === 'FAKE') return 'REHEARSAL'
  if (status === 'COMPLETE') return 'RUN COMPLETE'
  return 'JUDGED RUN'
}

function runBadgeTone(mode: 'FAKE' | 'JUDGE', status: string): string {
  if (mode === 'FAKE') return 'bg-amber-300/15 text-amber-100'
  if (status === 'COMPLETE') return 'bg-emerald-400/20 text-emerald-200'
  return 'bg-white/10 text-white/75'
}

export function RunControl() {
  const { runtimeRun, apiConnected, runtimeError, loginOwner, activatePilot, decideCampaign } = useDemo()
  const [showLogin, setShowLogin] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [ownerAuthenticated, setOwnerAuthenticated] = useState(false)
  const [verification, setVerification] = useState<VerificationReport | null>(null)

  useEffect(() => {
    let cancelled = false
    void getOwnerSession()
      .then((session) => {
        if (!cancelled) setOwnerAuthenticated(session.authenticated)
      })
      .catch(() => {
        if (!cancelled) setOwnerAuthenticated(false)
      })
    return () => { cancelled = true }
  }, [])

  if (!apiConnected || !runtimeRun) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-line px-4 py-3 text-sm text-muted">
        Local visual shell · start the API and seed a run to switch this dashboard to persisted run state.
        {runtimeError ? <span role="alert" className="ml-2 text-red-700">{runtimeError}</span> : null}
      </div>
    )
  }

  const act = async (operation: () => Promise<void>) => {
    setBusy(true)
    setActionError(null)
    try {
      await operation()
    } catch (error) {
      if (error instanceof Error && error.message === 'OWNER_AUTH_REQUIRED') {
        setOwnerAuthenticated(false)
        setShowLogin(true)
      } else setActionError(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const hasLiveProof = runtimeRun.proof.some((item) => item.live)
  const hasMockProof = runtimeRun.proof.some((item) => !item.live)
  const isHybridDemo = runtimeRun.mode === 'FAKE' && hasLiveProof && hasMockProof
  const hasMockTeracProof = runtimeRun.proof.some((item) => item.provider === 'TERAC' && !item.live)
  const runBadge = runBadgeLabel(runtimeRun.mode, runtimeRun.status, isHybridDemo)
  const runBadgeClass = runBadgeTone(runtimeRun.mode, runtimeRun.status)
  let completionMessage: string | null = null
  let completionClass = 'text-emerald-200'
  if (runtimeRun.status === 'COMPLETE' && runtimeRun.mode === 'FAKE') {
    completionMessage = isHybridDemo
      ? 'Hybrid demo complete. Terac, Documenso, and inline workflow records are mock evidence; LIVE badges identify configured real adapters. This run is intentionally rejected by the judged-run verifier.'
      : 'Rehearsal complete. Fake provider records are intentionally rejected by the judged-run verifier.'
    completionClass = 'text-amber-100'
  } else if (runtimeRun.status === 'COMPLETE') {
    completionMessage = 'Run complete. The strict same-run verifier is the final proof-readiness gate.'
  }

  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-ink bg-ink text-white">
      <div className="flex items-start justify-between gap-5 px-5 py-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">Same-run control room</p>
          <h2 className="mt-1 text-lg font-medium">{runtimeRun.workspaceName} · {runtimeRun.status.replaceAll('_', ' ')}</h2>
          <p className="mt-1 text-xs text-white/60">Run {runtimeRun.id.slice(0, 12)} · {runtimeRun.mode} · owner actions {runtimeRun.ownerActions.used}/2</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] ${runBadgeClass}`}>
          {runBadge}
        </span>
      </div>

      <div className="border-t border-white/10 px-5 py-4">
        <div className="flex flex-wrap gap-1.5">
          {providerLabels.map((provider) => {
            const item = runtimeRun.proof.find((proof) => proof.provider === provider)
            const proofState = item ? (item.live ? 'LIVE' : 'FAKE') : 'MISSING'
            return (
              <span key={provider} title={item?.externalId} className={`rounded border px-2 py-1 font-mono text-[10px] ${item ? (item.live ? 'border-emerald-300/40 bg-emerald-300/15 text-emerald-100' : 'border-amber-200/40 bg-amber-200/15 text-amber-100') : 'border-white/25 bg-white/5 text-white/70'}`}>
                {provider} · {proofState}
              </span>
            )
          })}
        </div>

        {runtimeRun.status === 'AWAITING_PAYMENT' ? (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-md bg-white/5 p-3">
            <div><p className="text-sm">Activate the pilot</p><p className="text-xs text-white/55">Stripe test Checkout · $5 USD sandbox payment · teammate payer action</p></div>
            <button disabled={busy} onClick={() => void act(activatePilot)} className="rounded bg-white px-3 py-2 text-xs font-medium text-ink disabled:opacity-50">Open test checkout</button>
          </div>
        ) : null}

        {runtimeRun.status === 'AWAITING_CAMPAIGN_APPROVAL' ? (
          <div className="mt-4 flex items-center justify-between gap-4 rounded-md bg-white/5 p-3">
            <div><p className="text-sm">Owner action 1 of 2</p><p className="text-xs text-white/55">{hasMockTeracProof ? 'Approve the mock demo-selected campaign, or reject and pause the run.' : 'Approve Terac’s selected campaign, or reject and pause the run.'}</p></div>
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => void act(() => decideCampaign('REJECT'))} className="rounded border border-white/20 px-3 py-2 text-xs disabled:opacity-50">Reject</button>
              <button disabled={busy} onClick={() => void act(() => decideCampaign('APPROVE'))} className="rounded bg-white px-3 py-2 text-xs font-medium text-ink disabled:opacity-50">Approve</button>
            </div>
          </div>
        ) : null}

        {runtimeRun.status === 'AWAITING_OWNER_SIGNATURE' ? (
          <div className="mt-4 rounded-md bg-white/5 p-3"><p className="text-sm">Owner action 2 of 2 is waiting in Documenso</p><p className="mt-1 text-xs text-white/55">The buyer role-player signs second. Completion returns here through the signed webhook.</p></div>
        ) : null}

        {completionMessage ? <p role="status" aria-live="polite" className={`mt-4 text-sm ${completionClass}`}>{completionMessage}</p> : null}

        {runtimeRun.status === 'COMPLETE' ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button disabled={busy} onClick={() => void act(async () => setVerification(await verifyRun(runtimeRun.id)))} className="rounded border border-white/20 px-3 py-2 text-xs disabled:opacity-50">Run proof verification</button>
            {verification ? <span role="status" aria-live="polite" className={`text-xs ${verification.passed ? 'text-emerald-200' : 'text-amber-100'}`}>{verification.passed ? 'All proof checks passed' : `${verification.checks.filter((check) => !check.passed).length} proof checks need attention`}</span> : null}
          </div>
        ) : null}

        {ownerAuthenticated ? (
          <button disabled={busy} onClick={() => void act(async () => { await logoutOwner(); setOwnerAuthenticated(false) })} className="mt-3 text-[11px] text-white/50 underline decoration-white/20 underline-offset-4 disabled:opacity-50">Owner sign-out</button>
        ) : (
          <button onClick={() => setShowLogin((value) => !value)} className="mt-3 text-[11px] text-white/50 underline decoration-white/20 underline-offset-4">Owner sign-in</button>
        )}
        {!ownerAuthenticated && showLogin ? (
          <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(event) => {
            event.preventDefault()
            void act(async () => { await loginOwner(email, password); setOwnerAuthenticated(true); setShowLogin(false); setPassword('') })
          }}>
            <label className="sr-only" htmlFor="owner-email">Owner email</label>
            <input id="owner-email" required type="email" name="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Owner email" className="rounded border border-white/15 bg-white/10 px-3 py-2 text-xs text-white placeholder:text-white/35" />
            <label className="sr-only" htmlFor="owner-password">Owner password</label>
            <input id="owner-password" required type="password" name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" className="rounded border border-white/15 bg-white/10 px-3 py-2 text-xs text-white placeholder:text-white/35" />
            <button disabled={busy} className="rounded bg-white/15 px-3 py-2 text-xs disabled:opacity-50">Sign in</button>
          </form>
        ) : null}
        {actionError || runtimeError ? <p role="alert" className="mt-2 text-xs text-red-300">{actionError ?? runtimeError}</p> : null}
      </div>
    </section>
  )
}
