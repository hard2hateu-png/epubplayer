export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  ts: number
  level: LogLevel
  subsystem: string
  message: string
  data?: unknown
  /** @deprecated Use subsystem instead */
  source?: string
}

const PERSIST_KEY = 'epubplayer:recentDebugLogs:v1'
const PERSIST_ENTRY_LIMIT = 160
const PERSIST_MESSAGE_LIMIT = 1600
const PERSIST_INTERVAL_MS = 2000

function formatTs(ts: number): string {
  const d = new Date(ts)
  // Keep this compact and sortable
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message || String(value)
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatMessage(args: unknown[]): string {
  return args.map(safeStringify).join(' ')
}

function loadPersistedEntries(): LogEntry[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is LogEntry => {
        return (
          entry &&
          typeof entry.id === 'string' &&
          typeof entry.ts === 'number' &&
          typeof entry.level === 'string' &&
          typeof entry.subsystem === 'string' &&
          typeof entry.message === 'string'
        )
      })
      .slice(-PERSIST_ENTRY_LIMIT)
  } catch {
    return []
  }
}

function compactEntry(entry: LogEntry): LogEntry {
  return {
    id: entry.id,
    ts: entry.ts,
    level: entry.level,
    subsystem: entry.subsystem,
    message: entry.message.slice(0, PERSIST_MESSAGE_LIMIT),
    source: entry.source,
  }
}

class LogStore {
  private entries: LogEntry[] = loadPersistedEntries()
  private listeners = new Set<() => void>()
  private maxEntries = 2000
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  /** @deprecated Use addStructured instead */
  add(level: LogLevel, source: string, ...args: unknown[]) {
    this.addEntry({
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      level,
      subsystem: source,
      message: formatMessage(args),
      data: args.length === 1 ? args[0] : args,
      source, // Keep for backwards compat
    })
  }

  /** Add a structured log entry from the logger system */
  addStructured(level: LogLevel, subsystem: string, message: string, data?: unknown) {
    this.addEntry({
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      level,
      subsystem,
      message,
      data,
    })
  }

  private addEntry(entry: LogEntry) {
    this.entries.push(entry)
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries)
    }

    if (entry.level === 'error') {
      this.flushPersistence()
    } else {
      this.schedulePersistence()
    }

    for (const l of this.listeners) l()
  }

  private schedulePersistence() {
    if (this.persistTimer || typeof localStorage === 'undefined') return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.flushPersistence()
    }, PERSIST_INTERVAL_MS)
  }

  flushPersistence() {
    if (typeof localStorage === 'undefined') return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      const recent = this.entries.slice(-PERSIST_ENTRY_LIMIT).map(compactEntry)
      localStorage.setItem(PERSIST_KEY, JSON.stringify(recent))
    } catch {
      // Never let debug persistence interfere with playback or app startup.
    }
  }

  clear() {
    this.entries = []
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      localStorage.removeItem(PERSIST_KEY)
    } catch {
      // Ignore storage failures.
    }
    for (const l of this.listeners) l()
  }

  getSnapshot(): LogEntry[] {
    return this.entries
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  toText(): string {
    return this.entries
      .map((e) => `[${formatTs(e.ts)}] [${e.subsystem}] [${e.level.toUpperCase()}] ${e.message}`)
      .join('\n')
  }

  /** Get unique subsystems from current entries */
  getSubsystems(): string[] {
    const subsystems = new Set<string>()
    for (const entry of this.entries) {
      subsystems.add(entry.subsystem)
    }
    return Array.from(subsystems).sort()
  }
}

export const logStore = new LogStore()

