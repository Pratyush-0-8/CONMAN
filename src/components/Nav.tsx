import { useEffect, useRef, useState } from 'react'
import { Icon, Wordmark, Avatar, Button, RatingBadge } from './ui'
import type { PlayerStats } from '../lib/game'

export type Page = 'home' | 'leaderboard' | 'history' | 'profile'
const ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: 'home', label: 'Play', icon: 'bolt' }, { id: 'leaderboard', label: 'Leaderboard', icon: 'trophy' },
  { id: 'history', label: 'History', icon: 'clock' }, { id: 'profile', label: 'Profile', icon: 'user' },
]

function ProfileMenu({ player, email, go, onSignOut }: { player: PlayerStats; email?: string; go: (p: Page) => void; onSignOut: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const d = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', d); document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', d); document.removeEventListener('keydown', k) }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label="Account menu" aria-expanded={open} className="flex items-center gap-1.5 rounded-xl p-0.5 transition-colors hover:bg-white/5"><Avatar name={player.name} size={34} /><Icon name="chev" size={14} className={`text-mute transition-transform max-sm:hidden ${open ? 'rotate-180' : ''}`} /></button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 animate-fade-up rounded-2xl border border-line bg-card p-2 shadow-2xl">
          <div className="flex items-center gap-3 px-3 py-3"><Avatar name={player.name} size={40} /><div className="min-w-0"><div className="truncate text-sm font-semibold">{player.name}</div>{email && <div className="truncate text-xs text-mute">{email}</div>}</div></div>
          <div className="px-3 pb-2 sm:hidden"><RatingBadge elo={player.elo} showRank /></div>
          <div className="my-1 h-px bg-line" />
          <button onClick={() => { setOpen(false); go('profile') }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-mute hover:bg-white/5 hover:text-ink"><Icon name="user" size={16} />Profile</button>
          <button onClick={() => { setOpen(false); onSignOut() }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-lose hover:bg-lose/10"><Icon name="logout" size={16} />Sign out</button>
        </div>
      )}
    </div>
  )
}

export function Nav({ page, go, player, email, onPlay, onSignOut, onSignIn, onSignUp, onLanding }: {
  page: Page; go: (p: Page) => void; player: PlayerStats | null; email?: string; onPlay: () => void
  onSignOut: () => void; onSignIn: () => void; onSignUp: () => void; onLanding: () => void
}) {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <button onClick={player ? () => go('home') : onLanding} aria-label="CONMAN home"><Wordmark /></button>
          {player && (
            <nav className="hidden items-center gap-1 md:flex">
              {ITEMS.map((i) => (
                <button key={i.id} onClick={() => go(i.id)} className={`relative rounded-lg px-4 py-2 text-sm font-medium transition-colors ${page === i.id ? 'text-ink' : 'text-mute hover:text-ink'}`}>
                  {i.label}
                  {page === i.id && <span className="absolute inset-x-4 -bottom-[17px] h-px bg-accent" />}
                </button>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-3">
            {player ? (
              <>
                <span className="hidden sm:block"><RatingBadge elo={player.elo} /></span>
                <Button variant="primary" size="sm" onClick={onPlay} className="hidden sm:inline-flex">Find Match</Button>
                <ProfileMenu player={player} email={email} go={go} onSignOut={onSignOut} />
              </>
            ) : (
              <><Button variant="ghost" size="sm" onClick={onSignIn}>Sign In</Button><Button variant="primary" size="sm" onClick={onSignUp}>Create Account</Button></>
            )}
          </div>
        </div>
      </header>
      {player && (
        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
          {ITEMS.map((i) => (
            <button key={i.id} onClick={() => go(i.id)} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${page === i.id ? 'text-accent' : 'text-mute'}`}>
              <Icon name={i.icon} size={20} />{i.label}
            </button>
          ))}
        </nav>
      )}
    </>
  )
}
