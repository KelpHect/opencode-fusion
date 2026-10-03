import { makeLanguageModel } from './models.js'

export function createFusionE2ESDK(_options: Record<string, unknown> = {}) {
  return {
    languageModel: (id: string) => makeLanguageModel(id),
  }
}
