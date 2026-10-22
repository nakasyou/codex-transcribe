import { chromeProvider } from './chrome'
import { codexProvider } from './codex'
import type { TranscriptionProvider } from '../types'

/** Add new provider implementations here; CLI names and validation follow automatically. */
export const providers = [
  codexProvider,
  chromeProvider,
] as const satisfies readonly TranscriptionProvider[]
export type Provider = (typeof providers)[number]['id']
export type RegisteredProviderOptions = Parameters<(typeof providers)[number]['transcribeFile']>[1]

export function getProvider(
  value: string = 'codex',
): TranscriptionProvider & { readonly id: Provider } {
  const provider = providers.find(
    (provider: TranscriptionProvider) => provider.id === value || provider.aliases?.includes(value),
  )
  if (!provider) {
    throw new Error(
      `Unknown provider. Choose ${providers.map((provider) => provider.id).join(' or ')}.`,
    )
  }
  return provider
}

export function parseProvider(value: string = 'codex'): Provider {
  return getProvider(value).id
}
