import type { Page } from '../components/Nav'
import type { AuthRoute } from '../screens/Auth'

export interface Navigation { page: Page; route: AuthRoute | 'app'; profileId?: string }
const pages: Record<Page,string> = { daily:'/',home:'/arena',leaderboard:'/leaderboard',history:'/history',profile:'/profile',social:'/friends' }
const auth: Record<Exclude<AuthRoute,'landing'>,string> = { signin:'/signin',signup:'/signup',forgot:'/forgot', 'reset-sent':'/reset-sent',verify:'/verify','verify-invalid':'/verify-invalid' }
export const pagePath = (page: Page) => pages[page]
export function navigationPath({ page,route,profileId }: Navigation) { return route==='app' ? (profileId ? `/players/${profileId}` : pages[page]) : route==='landing' ? pages.home : auth[route] }
export function readNavigation(pathname: string, returnPage?: unknown): Navigation {
  const path=pathname.replace(/\/+$/,'') || '/'
  const player = path.match(/^\/players\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  if (player) return { page:'social',route:'app',profileId:player[1] }
  for (const [page,url] of Object.entries(pages)) if (path===url) return { page:page as Page,route:'app' }
  for (const [route,url] of Object.entries(auth)) if (path===url) return { page:typeof returnPage==='string' && returnPage in pages ? returnPage as Page : 'daily',route:route as AuthRoute }
  return { page:'daily',route:'app' }
}
