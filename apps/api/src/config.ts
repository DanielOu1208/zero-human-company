import './env.js'
import { z } from 'zod'

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const optionalEnv = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  schema.optional(),
)

const localAuthDefaults = {
  COOKIE_SECRET: 'local-only-cookie-secret-change-me',
  OWNER_EMAIL: 'owner@example.com',
  OWNER_PASSWORD: 'local-owner-password',
} as const

const forbiddenProductionAuthValues: Record<keyof typeof localAuthDefaults, ReadonlySet<string>> = {
  COOKIE_SECRET: new Set([localAuthDefaults.COOKIE_SECRET, 'replace-with-at-least-32-random-characters']),
  OWNER_EMAIL: new Set([localAuthDefaults.OWNER_EMAIL]),
  OWNER_PASSWORD: new Set([localAuthDefaults.OWNER_PASSWORD, 'replace-me']),
}

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@localhost:5432/zero_human_company'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  PORT: z.coerce.number().int().positive().default(3001),
  COOKIE_SECRET: z.string().min(32).default(localAuthDefaults.COOKIE_SECRET),
  OWNER_EMAIL: z.string().email().default(localAuthDefaults.OWNER_EMAIL),
  OWNER_PASSWORD: z.string().min(8).default(localAuthDefaults.OWNER_PASSWORD),
  JUDGE_MODE: booleanFromEnv,
  DEMO_HYBRID_MODE: booleanFromEnv,
  REAL_ACTIONS_ENABLED: booleanFromEnv,
  PROVIDER_MODE: z.enum(['fake', 'real']).default('fake'),
  OPENROUTER_API_KEY: optionalEnv(z.string()),
  OPENROUTER_BASE_URL: z.literal('https://openrouter.ai/api/v1').default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.literal('openai/gpt-5.6-luna').default('openai/gpt-5.6-luna'),
  STRIPE_SECRET_KEY: optionalEnv(z.string()),
  STRIPE_WEBHOOK_SECRET: optionalEnv(z.string()),
  STRIPE_MODE: z.literal('TEST').default('TEST'),
  LINQ_API_BASE_URL: optionalEnv(z.string().url()),
  LINQ_API_KEY: optionalEnv(z.string()),
  LINQ_WEBHOOK_SECRET: optionalEnv(z.string()),
  LINQ_NORDLICHT_RECIPIENT: optionalEnv(z.string()),
  LINQ_MAAS_RECIPIENT: optionalEnv(z.string()),
  TERAC_TRANSPORT: optionalEnv(z.enum(['http', 'mcp'])),
  TERAC_API_BASE_URL: optionalEnv(z.string().url()),
  TERAC_API_KEY: optionalEnv(z.string()),
  TERAC_STUDY_PATH: optionalEnv(z.string()),
  TERAC_CONTRACT_REVIEW_PATH: optionalEnv(z.string()),
  BAND_REST_URL: z.string().url().default('https://app.band.ai'),
  BAND_WS_URL: z.string().url().default('wss://app.band.ai/api/v1/socket/websocket'),
  BAND_AGENT_BRAIN: z.literal('CODEX').default('CODEX'),
  BAND_CODEX_THREAD_STATE_PATH: optionalEnv(z.string().min(1)),
  BAND_CODEX_WORKING_DIRECTORY: optionalEnv(z.string().min(1)),
  BAND_CODEX_RUNTIME_HOME: optionalEnv(z.string().min(1)),
  BAND_RESEARCHER_AGENT_ID: optionalEnv(z.string()),
  BAND_RESEARCHER_API_KEY: optionalEnv(z.string()),
  BAND_NEGOTIATOR_AGENT_ID: optionalEnv(z.string()),
  BAND_NEGOTIATOR_API_KEY: optionalEnv(z.string()),
  BAND_POLICY_AGENT_ID: optionalEnv(z.string()),
  BAND_POLICY_AGENT_API_KEY: optionalEnv(z.string()),
  DOCUMENSO_API_BASE_URL: optionalEnv(z.string().url()).default('https://app.documenso.com/api/v2'),
  DOCUMENSO_API_KEY: optionalEnv(z.string()),
  DOCUMENSO_TEMPLATE_ID: optionalEnv(z.string()),
  DOCUMENSO_WEBHOOK_SECRET: optionalEnv(z.string()),
  DOCUMENSO_CREATE_PATH: optionalEnv(z.string()).default('/envelope/use'),
  DOCUMENSO_RECONCILE_PATH: optionalEnv(z.string()).default('/envelope?externalId={externalId}'),
  DOCUMENSO_OWNER_RECIPIENT_ID: optionalEnv(z.string()),
  DOCUMENSO_BUYER_RECIPIENT_ID: optionalEnv(z.string()),
  DOCUMENSO_BUYER_EMAIL: optionalEnv(z.string().email()),
  MONID_API_BASE_URL: optionalEnv(z.string().url()),
  MONID_API_KEY: optionalEnv(z.string()),
  RENDER_API_KEY: optionalEnv(z.string()),
  RENDER_OWNER_ID: optionalEnv(z.string()),
  RENDER_WORKFLOW_SLUG: optionalEnv(z.string()),
}).superRefine((config, context) => {
  if (config.JUDGE_MODE && config.DEMO_HYBRID_MODE) {
    context.addIssue({
      code: 'custom',
      path: ['DEMO_HYBRID_MODE'],
      message: 'DEMO_HYBRID_MODE must be false when JUDGE_MODE=true',
    })
  }

  if (config.DEMO_HYBRID_MODE) {
    if (config.PROVIDER_MODE !== 'real') {
      context.addIssue({
        code: 'custom',
        path: ['PROVIDER_MODE'],
        message: 'DEMO_HYBRID_MODE requires PROVIDER_MODE=real',
      })
    }
    if (!config.REAL_ACTIONS_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['REAL_ACTIONS_ENABLED'],
        message: 'DEMO_HYBRID_MODE requires REAL_ACTIONS_ENABLED=true',
      })
    }
  }

  if (config.NODE_ENV !== 'production') return

  for (const key of Object.keys(localAuthDefaults) as Array<keyof typeof localAuthDefaults>) {
    if (forbiddenProductionAuthValues[key].has(config[key])) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must be explicitly configured to a non-local value in production`,
      })
    }
  }
})

export type AppConfig = z.infer<typeof configSchema>

let cached: AppConfig | undefined

export function getConfig(): AppConfig {
  cached ??= configSchema.parse(process.env)
  if (cached.JUDGE_MODE && (cached.PROVIDER_MODE !== 'real' || !cached.REAL_ACTIONS_ENABLED)) {
    throw new Error('JUDGE_MODE requires PROVIDER_MODE=real and REAL_ACTIONS_ENABLED=true')
  }
  return cached
}

export const judgeRequiredEnv = [
  'OPENROUTER_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'LINQ_API_BASE_URL',
  'LINQ_API_KEY',
  'LINQ_WEBHOOK_SECRET',
  'LINQ_NORDLICHT_RECIPIENT',
  'LINQ_MAAS_RECIPIENT',
  'TERAC_TRANSPORT',
  'TERAC_API_BASE_URL',
  'TERAC_API_KEY',
  'TERAC_STUDY_PATH',
  'TERAC_CONTRACT_REVIEW_PATH',
  'BAND_RESEARCHER_AGENT_ID',
  'BAND_RESEARCHER_API_KEY',
  'BAND_NEGOTIATOR_AGENT_ID',
  'BAND_NEGOTIATOR_API_KEY',
  'BAND_POLICY_AGENT_ID',
  'BAND_POLICY_AGENT_API_KEY',
  'BAND_AGENT_BRAIN',
  'DOCUMENSO_API_KEY',
  'DOCUMENSO_TEMPLATE_ID',
  'DOCUMENSO_WEBHOOK_SECRET',
  'DOCUMENSO_OWNER_RECIPIENT_ID',
  'DOCUMENSO_BUYER_RECIPIENT_ID',
  'DOCUMENSO_BUYER_EMAIL',
  'MONID_API_BASE_URL',
  'MONID_API_KEY',
  'RENDER_API_KEY',
  'RENDER_OWNER_ID',
  'RENDER_WORKFLOW_SLUG',
] as const

export function missingJudgeConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  return judgeRequiredEnv.filter((key) => !env[key])
}
