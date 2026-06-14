import { Info } from 'lucide-react'
import type { RelayInstance } from '../../../main/relay'
import { Toggle } from './Toggle'

function shortPath(p: string): string {
  return p.split('/').pop() ?? p
}

interface Props {
  instance: RelayInstance
  onToggleMirror: (index: number, enabled: boolean) => Promise<void>
}

export function InstanceRow({ instance, onToggleMirror }: Props): React.JSX.Element {
  const procLabel = instance.process
    ? `${instance.process.name} (pid ${instance.process.pid})`
    : 'unknown process'

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
      </div>
      <span className="text-xs text-zinc-500">{procLabel}</span>
    </div>
  )

  if (instance.isPrimary) {
    return (
      <div className="flex items-center justify-between gap-2">
        {info}
        <Info className="w-4 h-4 text-zinc-400 hover:text-zinc-100 cursor-help transition-colors">
          <title>
            The primary instance gets full passthrough and can&apos;t be turned off. It&apos;s
            always the Discord instance that started first (discord-ipc-0). To make a different
            instance primary, close this one first so the other claims that slot, then restart the
            relay.
          </title>
        </Info>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-2">
      {info}
      <Toggle
        checked={instance.enabled}
        onChange={(checked) => onToggleMirror(instance.index, checked)}
      />
    </div>
  )
}
