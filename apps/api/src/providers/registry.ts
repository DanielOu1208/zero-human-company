import { getConfig } from '../config.js'
import type { ProviderRegistry } from '../outbox.js'
import { BandExternalAgentProvider } from './band/index.js'
import { DocumensoProvider } from './documenso/index.js'
import type { DocumensoEnvelopeData, DocumensoEnvelopeRequest } from './documenso/types.js'
import { FakeProvider } from './fake.js'
import { LinqMessageProvider } from './linq/index.js'
import { FakeMonidDiscoveryProvider, MonidDiscoveryProvider } from './monid/index.js'
import { OpenRouterSalesProvider } from './openai.js'
import { standardDocumensoCodec, standardTeracCodec } from './standard-codecs.js'
import { StripeCheckoutProvider } from './stripe/index.js'
import { FakeTeracProvider, TeracProvider } from './terac/index.js'
import type { ProviderPort } from './types.js'
import {
  TeracContractReviewProvider,
  type ContractReviewRequest,
  type ContractReviewResult,
} from './terac/contract-review.js'

export function createProviderRegistry(): ProviderRegistry {
  const config = getConfig()
  if (config.PROVIDER_MODE === 'fake') {
    return new Map<string, ProviderPort<any, any>>([
      ['STRIPE', new FakeProvider('STRIPE', 'checkout.session.create', () => ({
        accepted: true,
        checkoutUrl: `${config.PUBLIC_BASE_URL}/app/dashboard?payment=fake`,
      }))],
      ['TERAC', new FakeTeracProvider()],
      ['LINQ', new FakeProvider('LINQ', 'message.send')],
      ['BAND', new FakeProvider('BAND', 'external_agents.negotiate')],
      ['DOCUMENSO', new FakeProvider('DOCUMENSO', 'sequential-envelope')],
      ['MONID', new FakeMonidDiscoveryProvider()],
      ['OPENAI', new FakeProvider('OPENAI', 'structured-outreach')],
      ['RENDER', new FakeProvider('RENDER', 'workflow.task')],
    ])
  }
  const stripe = new StripeCheckoutProvider({
    secretKey: config.STRIPE_SECRET_KEY ?? '',
    webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? '',
    successUrl: `${config.PUBLIC_BASE_URL}/app/dashboard?payment=success`,
    cancelUrl: `${config.PUBLIC_BASE_URL}/app/dashboard?payment=cancelled`,
    mode: config.STRIPE_MODE,
  })
  const terac: ProviderPort<any, any> = config.DEMO_HYBRID_MODE
    ? new FakeTeracProvider()
    : new TeracProvider({ baseUrl: config.TERAC_API_BASE_URL, apiKey: config.TERAC_API_KEY, accountStudyPath: config.TERAC_STUDY_PATH }, standardTeracCodec)
  const documenso: ProviderPort<any, any> = config.DEMO_HYBRID_MODE
    ? new FakeProvider<DocumensoEnvelopeRequest, DocumensoEnvelopeData & Record<string, unknown>>('DOCUMENSO', 'sequential-envelope', (request) => ({
      envelopeId: `mock_documenso_${request.idempotencyKey}`,
      externalId: request.idempotencyKey,
      status: 'CREATED',
      templateId: 'mock-template-v1',
      signingOrder: ['owner', 'buyer'],
    }))
    : new DocumensoProvider({
      baseUrl: config.DOCUMENSO_API_BASE_URL,
      apiKey: config.DOCUMENSO_API_KEY,
      templateId: config.DOCUMENSO_TEMPLATE_ID,
      ownerEmail: config.OWNER_EMAIL,
      buyerEmail: config.DOCUMENSO_BUYER_EMAIL,
    }, standardDocumensoCodec(config.DOCUMENSO_CREATE_PATH, config.DOCUMENSO_RECONCILE_PATH, config.DOCUMENSO_OWNER_RECIPIENT_ID ?? '', config.DOCUMENSO_BUYER_RECIPIENT_ID ?? ''))
  const registry: ProviderRegistry = new Map<string, ProviderPort<any, any>>([
    ['STRIPE', stripe],
    ['TERAC', terac],
    ['LINQ', new LinqMessageProvider({
      apiBaseUrl: config.LINQ_API_BASE_URL ?? '',
      apiKey: config.LINQ_API_KEY ?? '',
      webhookSecret: config.LINQ_WEBHOOK_SECRET ?? '',
      recipientAddresses: {
        nordlicht: config.LINQ_NORDLICHT_RECIPIENT,
        maas: config.LINQ_MAAS_RECIPIENT,
      },
    })],
    ['BAND', new BandExternalAgentProvider({
      restUrl: config.BAND_REST_URL,
      researcherAgentId: config.BAND_RESEARCHER_AGENT_ID,
      researcherApiKey: config.BAND_RESEARCHER_API_KEY,
      negotiatorAgentId: config.BAND_NEGOTIATOR_AGENT_ID,
      negotiatorApiKey: config.BAND_NEGOTIATOR_API_KEY,
      policyReviewerAgentId: config.BAND_POLICY_AGENT_ID,
      policyReviewerApiKey: config.BAND_POLICY_AGENT_API_KEY,
    })],
    ['DOCUMENSO', documenso],
    ['MONID', new MonidDiscoveryProvider({ baseUrl: config.MONID_API_BASE_URL, apiKey: config.MONID_API_KEY })],
    ['OPENAI', new OpenRouterSalesProvider(
      config.OPENROUTER_API_KEY,
      config.OPENROUTER_MODEL,
      config.OPENROUTER_BASE_URL,
    )],
  ])
  return registry
}

export function createTeracContractReviewProvider(): ProviderPort<ContractReviewRequest, ContractReviewResult> {
  const config = getConfig()
  if (config.DEMO_HYBRID_MODE) {
    return new FakeProvider<ContractReviewRequest, ContractReviewResult & Record<string, unknown>>('TERAC', 'contract-review', (request) => ({
      status: 'COMPLETE',
      taskId: `mock_terac_contract_${request.idempotencyKey}`,
      issues: [{
        clause: 'DEMO-ONLY',
        severity: 'LOW',
        finding: 'Demo-only simulated contract review; no live Terac request was made.',
      }],
      recommendedText: 'Demo-only simulated recommendation; obtain a live provider review before relying on it.',
    }))
  }
  return new TeracContractReviewProvider({
    baseUrl: config.TERAC_API_BASE_URL,
    apiKey: config.TERAC_API_KEY,
    path: config.TERAC_CONTRACT_REVIEW_PATH,
  })
}

export async function preflightProviders(registry = createProviderRegistry()): Promise<Array<{ provider: string; live: boolean }>> {
  const config = getConfig()
  if (config.PROVIDER_MODE === 'real' && config.TERAC_TRANSPORT !== 'http') throw new Error('The deployed Terac adapter requires TERAC_TRANSPORT=http')
  if (config.PROVIDER_MODE === 'real' && config.BAND_AGENT_BRAIN !== 'CODEX') throw new Error('The judged Band worker requires BAND_AGENT_BRAIN=CODEX')
  const results: Array<{ provider: string; live: boolean }> = []
  for (const [name, provider] of registry) {
    await provider.preflight()
    results.push({ provider: name, live: provider.capabilities().live })
  }
  if (config.PROVIDER_MODE === 'real') {
    const contractReview = createTeracContractReviewProvider()
    await contractReview.preflight()
    results.push({ provider: 'TERAC_CONTRACT_REVIEW', live: contractReview.capabilities().live })
    results.push({
      provider: 'RENDER',
      live: !config.DEMO_HYBRID_MODE && Boolean(config.RENDER_API_KEY && config.RENDER_WORKFLOW_SLUG),
    })
  }
  return results
}
