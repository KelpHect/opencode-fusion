import { DEFAULT_OPTIONS, OPTION_LIMITS } from './policy.js'
import { FusionError, type FusionOptions } from './types.js'

const LIMIT_KEYS = [
  'maxDelegations',
  'maxWorkerSteps',
  'delegationTimeoutMs',
  'maxReportCharacters',
  'sidekickMaxOutputTokens',
] as const

export function resolveOptions(raw: Readonly<Record<string, unknown>> | undefined): FusionOptions {
  const resolved: FusionOptions = { ...DEFAULT_OPTIONS }
  if (!raw) return resolved
  for (const key of LIMIT_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    const limits = OPTION_LIMITS[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < limits.min || value > limits.max) {
      throw new FusionError('invalid_option', key)
    }
    resolved[key] = value
  }
  if (raw.backgroundByDefault !== undefined) {
    if (typeof raw.backgroundByDefault !== 'boolean') {
      throw new FusionError('invalid_option', 'backgroundByDefault')
    }
    resolved.backgroundByDefault = raw.backgroundByDefault
  }
  return resolved
}
