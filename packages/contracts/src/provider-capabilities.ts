/**
 * Run modes (architecture §5) and the provider capability model.
 *
 * UI parameters (model, quality, aspect handling) MUST be derived from
 * declared capabilities (U08 acceptance: 参数基于能力而非硬猜). The seed
 * registry below describes the BYOK direct mode only; managed-generation
 * capabilities arrive with the server-side allowlist (J04). `supportsInheritAspect`
 * reflects whether a model can keep the source image's aspect ratio — the
 * single-image protocol requires it, so models without it must show an
 * explicit notice instead of silently cropping.
 */

export type RunMode = 'catalog-only' | 'direct-byok' | 'managed-generation';

export const RUN_MODES: readonly RunMode[] = ['catalog-only', 'direct-byok', 'managed-generation'];

export interface ProviderModelCapabilities {
  id: string;
  label: string;
  supportsInheritAspect: boolean;
  qualities: string[];
  /** Declared output size options; empty means unknown → show a notice. */
  sizes: string[];
}

export interface ProviderCapabilities {
  id: string;
  label: string;
  models: ProviderModelCapabilities[];
}

/** Model ids are user-configurable labels for BYOK; no endpoint is implied. */
export const DIRECT_BYOK_CAPABILITIES: ProviderCapabilities = {
  id: 'direct-byok',
  label: '自定义接口（BYOK 直连）',
  models: [
    {
      id: 'gpt-image-2',
      label: 'GPT Image 2',
      supportsInheritAspect: false,
      qualities: ['high', 'medium', 'low'],
      sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    },
    {
      id: 'custom',
      label: '自定义模型（能力未知）',
      supportsInheritAspect: false,
      qualities: [],
      sizes: [],
    },
  ],
};

export function modelCapabilities(
  provider: ProviderCapabilities,
  modelId: string,
): ProviderModelCapabilities | undefined {
  return provider.models.find((model) => model.id === modelId);
}
