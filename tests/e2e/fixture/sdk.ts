export function createFusionE2ESDK(_options: Record<string, unknown> = {}) {
  return {
    languageModel: () => {
      throw new Error('fusion e2e fixture language hook required')
    },
  }
}
