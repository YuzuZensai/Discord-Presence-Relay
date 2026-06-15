import { useEffect, useState } from 'react'
import { ChevronLeft, Info, Settings } from 'lucide-react'
import type { RelayStatus } from '../../main/relay'
import { InstanceRow } from './components/InstanceRow'
import { Toggle } from './components/Toggle'
import { Button, LinkButton } from './components/Button'

const EMPTY_STATUS: RelayStatus = {
  running: false,
  waiting: false,
  unsupported: false,
  instances: [],
  connectedClients: [],
  lastActivity: null,
  error: null
}

function formatElapsed(start: number | null, end: number | null): string | null {
  const now = Date.now()
  if (end && end > now) {
    const remaining = Math.max(0, end - now)
    return `${formatDuration(remaining)} left`
  }
  if (start && start <= now) {
    return `${formatDuration(now - start)} elapsed`
  }
  return null
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function ActivityPreview({
  activity
}: {
  activity: RelayStatus['lastActivity']
}): React.JSX.Element | null {
  if (!activity) return null

  const { app, details, state, assets, timestamps, buttons, at } = activity
  const elapsed = timestamps ? formatElapsed(timestamps.start, timestamps.end) : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <div className="relative shrink-0 w-16 h-16">
          {assets?.largeImage ? (
            <img
              src={assets.largeImage}
              alt={assets.largeText ?? app ?? ''}
              title={assets.largeText ?? undefined}
              className="w-16 h-16 rounded-lg object-cover bg-zinc-700"
            />
          ) : (
            <div className="w-16 h-16 rounded-lg bg-zinc-700 flex items-center justify-center text-zinc-500 text-xs">
              {app ? app.slice(0, 2).toUpperCase() : '—'}
            </div>
          )}
          {assets?.smallImage && (
            <img
              src={assets.smallImage}
              alt={assets.smallText ?? ''}
              title={assets.smallText ?? undefined}
              className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full ring-2 ring-zinc-800 object-cover bg-zinc-700"
            />
          )}
        </div>

        <div className="flex flex-col justify-center min-w-0">
          {app && <div className="text-sm font-medium text-zinc-100 truncate">{app}</div>}
          {details && <div className="text-sm text-zinc-200 truncate">{details}</div>}
          {state && <div className="text-sm text-zinc-400 truncate">{state}</div>}
          {elapsed && <div className="text-xs text-zinc-500 mt-0.5">{elapsed}</div>}
        </div>
      </div>

      {buttons.length > 0 && (
        <div className="flex gap-2">
          {buttons.map((button, i) => (
            <LinkButton key={i} href={button.url} className="flex-1 text-xs py-1.5 px-2">
              {button.label}
            </LinkButton>
          ))}
        </div>
      )}

      <div className="text-xs text-zinc-500">
        Last mirrored at {new Date(at).toLocaleTimeString()}
      </div>
    </div>
  )
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<RelayStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(false)
  const [autostart, setAutostart] = useState(false)
  const [startMinimized, setStartMinimized] = useState(false)
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [appVersion, setAppVersion] = useState<{ version: string; commit: string } | null>(null)

  useEffect(() => {
    void (async () => {
      setStatus(await window.api.getStatus())
      setAutostart(await window.api.getAutostart())
      setStartMinimized(await window.api.getStartMinimized())
      setAppVersion(await window.api.getVersion())
    })()

    return window.api.onStatus(setStatus)
  }, [])

  const toggleRelay = async (): Promise<void> => {
    setLoading(true)
    try {
      if (status.running || status.waiting) {
        await window.api.stop()
      } else {
        await window.api.start()
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const onToggleMirror = async (index: number, enabled: boolean): Promise<void> => {
    setStatus(await window.api.setMirrorEnabled(index, enabled))
  }

  const onToggleAutostart = async (enabled: boolean): Promise<void> => {
    setAutostart(await window.api.setAutostart(enabled))
  }

  const onToggleStartMinimized = async (enabled: boolean): Promise<void> => {
    setStartMinimized(await window.api.setStartMinimized(enabled))
  }

  if (status.unsupported) {
    return (
      <div className="flex flex-col h-screen items-center justify-center p-5 gap-3 text-center">
        <h1 className="text-lg font-semibold">Discord RPC Relay</h1>
        <p className="text-sm text-zinc-400">Windows is not supported.</p>
      </div>
    )
  }

  if (view === 'settings') {
    return (
      <div className="flex flex-col h-screen p-5 gap-4">
        <header className="flex items-center gap-3">
          <Button
            variant="ghost"
            onClick={() => setView('main')}
            aria-label="Back"
            className="p-1.5"
          >
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <h1 className="text-lg font-semibold">Settings</h1>
        </header>

        <section className="rounded-xl bg-zinc-800/60 border border-zinc-700 p-4 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm">Start on login</span>
            <span className="text-xs text-zinc-500">Launch automatically when you sign in</span>
          </div>
          <Toggle checked={autostart} onChange={onToggleAutostart} />
        </section>

        <section className="rounded-xl bg-zinc-800/60 border border-zinc-700 p-4 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm">Start minimized</span>
            <span className="text-xs text-zinc-500">Open to the tray instead of a window</span>
          </div>
          <div className="flex items-center gap-2">
            {!autostart && (
              <Info className="w-4 h-4 text-zinc-400 hover:text-zinc-100 cursor-help transition-colors shrink-0">
                <title>Only applies when &quot;Start on login&quot; is enabled.</title>
              </Info>
            )}
            <Toggle
              checked={startMinimized}
              onChange={onToggleStartMinimized}
              disabled={!autostart}
            />
          </div>
        </section>

        {appVersion && (
          <p className="text-xs text-zinc-500 mt-auto">
            Version {appVersion.version} ({appVersion.commit})
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen p-5 gap-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Discord RPC Relay</h1>
        <Button
          variant="ghost"
          onClick={() => setView('settings')}
          aria-label="Settings"
          className="p-1.5"
        >
          <Settings className="w-5 h-5" />
        </Button>
      </header>

      {status.error && (
        <div className="rounded-lg bg-red-950 border border-red-800 text-red-200 text-sm px-3 py-2">
          {status.error}
        </div>
      )}

      <section className="rounded-xl bg-zinc-800/60 border border-zinc-700 p-4 flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-sm">Relay</span>
          <span
            className={`text-xs ${
              status.running
                ? 'text-emerald-400'
                : status.waiting
                  ? 'text-amber-400'
                  : 'text-zinc-500'
            }`}
          >
            {status.running ? 'Running' : status.waiting ? 'Waiting for Discord…' : 'Stopped'}
          </span>
        </div>
        <Toggle
          checked={status.running || status.waiting}
          onChange={() => toggleRelay()}
          disabled={loading}
        />
      </section>

      <section className="rounded-xl bg-zinc-800/60 border border-zinc-700 p-4 flex flex-col gap-2">
        <h2 className="text-sm text-zinc-400 mb-1">Discord Instances</h2>
        <div className="flex flex-col gap-1.5 text-sm">
          {status.instances.length > 0 ? (
            status.instances.map((instance) => (
              <InstanceRow
                key={instance.index}
                instance={instance}
                onToggleMirror={onToggleMirror}
              />
            ))
          ) : (
            <div className="text-zinc-500">No Discord instances detected</div>
          )}
        </div>
      </section>

      <section className="rounded-xl bg-zinc-800/60 border border-zinc-700 p-4 flex flex-col gap-2">
        <h2 className="text-sm text-zinc-400 mb-1">Connected RPC Clients</h2>
        <div className="flex flex-col gap-1.5 text-sm">
          {status.connectedClients.length > 0 ? (
            status.connectedClients.map((client) => (
              <div key={client.id} className="flex items-center justify-between gap-2">
                <span className="text-zinc-300">
                  {client.process
                    ? `${client.process.name} (pid ${client.process.pid})`
                    : 'unknown process'}
                </span>
              </div>
            ))
          ) : (
            <div className="text-zinc-500">No clients connected</div>
          )}
        </div>
      </section>

      <section className="rounded-xl bg-zinc-800/60 border border-zinc-700 p-4 flex flex-col gap-2">
        <h2 className="text-sm text-zinc-400 mb-1">Last Mirrored Activity</h2>
        {status.lastActivity ? (
          <ActivityPreview activity={status.lastActivity} />
        ) : (
          <div className="text-sm text-zinc-300">No activity yet</div>
        )}
      </section>

      <p className="text-xs text-zinc-500 mt-auto">
        Apps using Discord Rich Presence need to be restarted after toggling the relay to pick up
        the change.
      </p>
    </div>
  )
}
