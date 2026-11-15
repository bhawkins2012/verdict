import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { ReviewStage } from '../types'

/** GET /api/config: the backend is the single source of truth for stage order and the nudge cadence. */
export interface StageConfig {
  stages: { stage: ReviewStage; label: string }[]
  nudgeCadence: { stage: ReviewStage; label: string; offset: { days: number } | { months: number } }[]
  consentCopy: string
}

export function useStageConfig() {
  return useQuery<StageConfig>({
    queryKey: ['stage-config'],
    queryFn: () => api.get('/config').then((r) => r.data),
    staleTime: 5 * 60_000, // matches the response's Cache-Control max-age
  })
}

/** Chronological position; CUSTOM (not on the timeline) and unknown stages sort last. */
export function stageRank(config: StageConfig, stage: ReviewStage): number {
  const i = stage === 'CUSTOM' ? -1 : config.stages.findIndex((s) => s.stage === stage)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

export function sortByStage<T extends { stage: ReviewStage }>(config: StageConfig, items: readonly T[]): T[] {
  return [...items].sort((a, b) => stageRank(config, a.stage) - stageRank(config, b.stage))
}

/** Stages shown on a thread's progress bar: the first impression, then each check-in. */
export function trackedStages(config: StageConfig): ReviewStage[] {
  return ['INITIAL', ...config.nudgeCadence.map((c) => c.stage)]
}
