export type ShellStatus = 'running' | 'done' | 'failed' | 'killed'

export type Shell = {
  n: number
  toolUseId: string
  tool: string
  command: string
  description?: string
  agentId?: string
  isBackground: boolean
  status: ShellStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  taskId?: string
  isFinal: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'shell-monitor': {
      shells: Shell[]
      slots: number[]
      queue: number[]
      nextN: number
      tasksDir: string
      scroll: Record<string, number>
      output: StateFamily<string>
    }
  }
}
