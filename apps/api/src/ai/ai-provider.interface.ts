import type { AiPromptRequest, AiPromptResponse } from './ai.types.js';

export interface AiProvider {
  readonly providerName: string;
  generate(request: AiPromptRequest): Promise<AiPromptResponse>;
}

export const AI_PROVIDER_TOKEN = Symbol('AI_PROVIDER');
