import { ArrowUpToLine, Info, Lock } from 'lucide-react'
import type { RelayInstance } from '../../../main/relay'
import { Toggle } from './Toggle'
import { Button } from './Button'

function shortPath(p: string): string {
  return p.split('/').pop() ?? p
}

interface Props {
  instance: RelayInstance
  reordering: boolean
  onToggleMirror: (index: number, enabled: boolean) => Promise<void>
  onUnlock: () => Promise<void>
  onPromote: (index: number) => Promise<void>
}

export function InstanceRow({
  instance,
  reordering,
  onToggleMirror,
  onUnlock,
  onPromote
}: Props): React.JSX.Element {
  const procLabel = instance.process
    ? `${instance.process.name} (pid ${instance.process.pid})`
    : 'unknown process'

  const canPromote = instance.process?.executable != null

  const promoteButton = (
    <Button
      variant="ghost"
      className="p-1 shrink-0"
      disabled={!canPromote || reordering}
      onClick={() => onPromote(instance.index)}
      aria-label="Promote to primary"
      title={
        !canPromote
          ? 'Cannot resolve this Discord’s executable path'
          : 'Make this Discord primary: restarts Discord clients so it starts first.'
      }
    >
      <ArrowUpToLine className="w-4 h-4 text-emerald-400" />
    </Button>
  )

  const unlockButton = (
    <Button
      variant="ghost"
      className="p-1 shrink-0"
      onClick={() => onUnlock()}
      aria-label="Unlock primary"
      title="Locked as primary. Click to unlock."
    >
      <Lock className="w-4 h-4 text-amber-400" />
    </Button>
  )

  const info = (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <span className={instance.isPrimary ? 'text-zinc-300' : ''}>
          {shortPath(instance.path)}
        </span>
        {instance.isPrimary ? (
          <span className="text-xs text-emerald-400">primary</span>
        ) : (
          <span className={`text-xs ${instance.enabled ? 'text-sky-400' : 'text-zinc-500'}`}>
            mirror #{instance.index}
          </span>
        )}
        {instance.locked && <span className="text-xs text-amber-400">locked</span>}
      </div>
      <span className="text-xs text-zinc-500">{procLabel}</span>
    </div>
  )

  if (instance.isPrimary) {
    return (
      <div className="flex items-center justify-between gap-2">
        {info}
        <div className="flex items-center gap-1 shrink-0">
          {instance.locked ? (
            unlockButton
          ) : (
            <Info className="w-4 h-4 text-zinc-400 hover:text-zinc-100 cursor-help transition-colors">
              <title>
                The primary instance gets full passthrough and can&apos;t be turned off. It&apos;s
                the Discord that started first (discord-ipc-0). Use Promote on another instance to
                make it primary instead.
              </title>
            </Info>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-2">
      {info}
      <div className="flex items-center gap-1 shrink-0">
        {instance.locked && unlockButton}
        {promoteButton}
        <Toggle
          checked={instance.enabled}
          onChange={(checked) => onToggleMirror(instance.index, checked)}
        />
      </div>
    </div>
  )
}
