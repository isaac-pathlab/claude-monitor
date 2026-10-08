export type AgentRunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'killed'

export type FeedLine =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tool: string; count: number; isError: boolean; toolUseIds: string[] }

export type AgentRun = {
  n: number
  agentId: string
  parentAgentId?: string
  description: string
  subagentType: string
  isBackground: boolean
  status: AgentRunStatus
  startedAt: number
  endedAt?: number
  toolUses: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': {
      agents: AgentRun[]
      slots: number[]
      queue: number[]
      nextN: number
      scroll: Record<string, number>
      now: number
      feed: StateFamily<FeedLine[]>
    }
  }
}
