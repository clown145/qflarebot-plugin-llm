declare module '*bridge.js' {
  export interface Bridge {
    readonly embedded: boolean
    readonly plugin: string
    readonly base: string
    readonly theme: string
    fetch(input: string, init?: RequestInit): Promise<Response>
    onTheme(handler: (theme: string) => void): () => void
    toast(message: string, level?: 'info' | 'success' | 'warning' | 'error'): void
    navigate(to: string): void
    setTitle(title: string): void
    resize(height?: number): void
    setDirty?(dirty: boolean): void
  }

  export function createBridge(options?: { timeout?: number; applyTheme?: boolean }): Promise<Bridge>
}
