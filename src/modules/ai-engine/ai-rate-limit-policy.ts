import { AiModelPurpose } from './ai-engine.types';

export type AiRateLimitTier =
  | 'cheap_text'
  | 'standard_structured'
  | 'expensive_reasoning'
  | 'vision_or_file'
  | 'public_guest';

export interface AiRateLimitPolicy {
  tier: AiRateLimitTier;
  windowMs: number;
  maxRequests: number;
  keyStrategy: 'authenticated_user_then_ip' | 'ip_only';
}

export const AI_RATE_LIMIT_POLICIES: Record<AiRateLimitTier, AiRateLimitPolicy> = {
  cheap_text: {
    tier: 'cheap_text',
    windowMs: 15 * 60 * 1000,
    maxRequests: 60,
    keyStrategy: 'authenticated_user_then_ip',
  },
  standard_structured: {
    tier: 'standard_structured',
    windowMs: 15 * 60 * 1000,
    maxRequests: 30,
    keyStrategy: 'authenticated_user_then_ip',
  },
  expensive_reasoning: {
    tier: 'expensive_reasoning',
    windowMs: 15 * 60 * 1000,
    maxRequests: 12,
    keyStrategy: 'authenticated_user_then_ip',
  },
  vision_or_file: {
    tier: 'vision_or_file',
    windowMs: 15 * 60 * 1000,
    maxRequests: 10,
    keyStrategy: 'authenticated_user_then_ip',
  },
  public_guest: {
    tier: 'public_guest',
    windowMs: 15 * 60 * 1000,
    maxRequests: 8,
    keyStrategy: 'ip_only',
  },
};

export const AI_RATE_LIMIT_TIER_BY_MODEL_PURPOSE: Record<
  AiModelPurpose,
  AiRateLimitTier
> = {
  fast_text: 'cheap_text',
  standard_json: 'standard_structured',
  complex_reasoning: 'expensive_reasoning',
  vision_audit: 'vision_or_file',
  structured_assessment: 'standard_structured',
  audio_tts: 'expensive_reasoning',
};
