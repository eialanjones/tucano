// Which login of a harness a reply runs on, and how much each has left.
// A harness has its usual login and the accounts added in Settings. In 'order' each agent stays on
// its own and moves on only when it runs out. In 'balance' a reply goes to the login with the most to
// spend before its budget (its longest window, the week on Claude) resets, so what is left at the reset
// isn't lost; the short windows only gate a login that is too close to its limit to be moved to.
// A session lives in its login's folder: changing login sends the whole conversation again. So the
// login in use is kept until another is clearly more urgent, or it is nearly out.
import type { Account, CodexQuota, EngineId, Quota, Settings } from './types'

export interface QuotaWindow {
  minutes: number
  utilization: number // 0..1
  resetsAt: number // ms; 0 when the CLI didn't say
}

// One login: the usual one (id '') or an account. `windows` is unset until it has reported them.
export interface Login {
  id: string
  account?: Account
  windows?: QuotaWindow[]
  at?: number // when the windows were read
}

export const USUAL_LOGIN = ''
// The key of a login's check in settings.accountChecks: the usual logins of two harnesses share the id ''.
export const checkKey = (engine: EngineId, id: string): string => id || `usual:${engine}`
export const SWITCH_GAP = 0.15 // no longer used by the pick; only kept for the old tests
export const ENTER_MIN = 0.2 // a login is only switched to when each of its short windows has this much left
export const SWITCH_RATIO = 1.5 // how many times more urgent another login must be to take over from the one in use
export const SWITCH_MIN = 0.15 // a login takes over from the one in use only with this much of its budget left: less isn't worth sending the conversation again
export const STALE_MS = 6 * 60 * 60_000 // a reading older than this is read again while balancing
export const URGENCY_MAX = 100
export const NEARLY_OUT = 0.05 // with this little left, the login in use is given up
export const SPENT_MS = 30 * 60_000 // how long a login that hit its limit sits out, when no window was near its end
export const NEARLY_FULL = 0.9 // a window this used is the one a limit error is about

export const quotaWindows = (q: Quota | CodexQuota | undefined): QuotaWindow[] | undefined => {
  if (!q) return undefined
  if ('windows' in q) return q.windows.length ? q.windows : undefined
  const windows = [...(q.fiveHour ? [{ minutes: 300, ...q.fiveHour }] : []), ...(q.sevenDay ? [{ minutes: 10_080, ...q.sevenDay }] : [])]
  return windows.length ? windows : undefined
}

// A window that already reset counts as empty: what it said was about the one before.
export const usedOf = (w: QuotaWindow, now: number): number => (w.resetsAt > 0 && w.resetsAt <= now ? 0 : Math.min(1, Math.max(0, w.utilization)))

// How much of its tightest window a login has left, 0..1. A login that never reported counts as
// full here, but isn't picked while another has reported (see pickLogin): the app checks it first.
export const leftOf = (login: Pick<Login, 'windows'>, now: number): number => (login.windows?.length ? 1 - Math.max(...login.windows.map((w) => usedOf(w, now))) : 1)

// All the accounts of a harness added up, window by window, against an even pace. Windows are matched by
// length (the 5-hour of one account with the 5-hour of the others); a length that fewer than two accounts
// reported says nothing about a sum, so it is left out. `pace` is where the average usage would be if it were
// spent evenly until the reset, so `used` past it means the accounts together run out before the window ends.
export interface Pace { minutes: number; used: number; pace: number; counted: number } // used, pace: 0..1
export const PACE_OVER = 3 // points past the pace the total may run before it counts as over
export const PACE_MIN_USED = 10 // below this many points used, a window that just opened is never over
export function paceOf(logins: Pick<Login, 'windows'>[], now: number): Pace[] {
  const reported = logins.filter((l) => l.windows?.length)
  if (reported.length < 2) return []
  const groups = new Map<number, QuotaWindow[]>()
  for (const l of reported)
    for (const w of l.windows ?? []) {
      if (w.resetsAt <= 0) continue
      groups.set(w.minutes, [...(groups.get(w.minutes) ?? []), w])
    }
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const paces: Pace[] = [...groups.entries()]
    .filter(([, ws]) => ws.length >= 2)
    .map(([minutes, ws]) => ({
      minutes,
      used: mean(ws.map((w) => usedOf(w, now))),
      pace: mean(ws.map((w) => (w.resetsAt <= now ? 0 : Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / (w.minutes * 60_000)))))),
      counted: ws.length
    }))
    .sort((a, b) => a.minutes - b.minutes)
  return paces.filter((_, i) => i === 0 || i === paces.length - 1)
}

// The signed-in logins of a harness: the usual one first, then the accounts in the order they were added.
// The harnesses whose logins report how much they have left: only these are checked and balanced.
// Another harness's extra logins (Antigravity's) stay each with its own agents.
export const QUOTA_ENGINES = ['claude', 'codex'] as const
export type QuotaEngine = (typeof QUOTA_ENGINES)[number]
export const hasQuota = (engine: EngineId): engine is QuotaEngine => (QUOTA_ENGINES as readonly EngineId[]).includes(engine)

export function loginsOf(settings: Pick<Settings, 'engines' | 'accounts' | 'quota' | 'codexQuota' | 'accountQuota'>, engine: EngineId): Login[] {
  if (!hasQuota(engine)) return []
  const usualQuota = engine === 'claude' ? settings.quota : settings.codexQuota
  const usual = { windows: quotaWindows(usualQuota), at: usualQuota?.at }
  return [
    ...(settings.engines[engine]?.loggedIn ? [{ id: USUAL_LOGIN, ...usual }] : []),
    ...(settings.accounts ?? [])
      .filter((a) => a.engine === engine && a.loggedIn)
      .map((a) => ({ id: a.id, account: a, windows: quotaWindows(settings.accountQuota?.[a.id]), at: settings.accountQuota?.[a.id]?.at }))
  ]
}

// A login's budget: its longest window (the week on Claude). The others are short ones that only limit the speed.
export const budgetOf = (login: Pick<Login, 'windows'>): QuotaWindow | undefined =>
  login.windows?.length ? login.windows.reduce((a, b) => (b.minutes > a.minutes ? b : a)) : undefined

// How fast the budget must be spent for none of it to be left at the reset: what is left over the share of
// the window still ahead. 1 is on pace, above 1 a surplus that would be lost, below 1 already spent ahead.
export function urgencyOf(login: Pick<Login, 'windows'>, now: number): number {
  const budget = budgetOf(login)
  if (!budget) return 0
  const left = 1 - usedOf(budget, now)
  const ahead = budget.resetsAt <= now ? 1 : Math.min(1, (budget.resetsAt - now) / (budget.minutes * 60_000))
  return Math.min(URGENCY_MAX, Math.max(0, left / Math.max(ahead, 1 / URGENCY_MAX)))
}

// How much the tightest short window (any but the budget) has left, 0..1; 1 when there is none.
export function shortLeftOf(login: Pick<Login, 'windows'>, now: number): number {
  const budget = budgetOf(login)
  const shorts = (login.windows ?? []).filter((w) => w !== budget)
  return shorts.length ? Math.min(...shorts.map((w) => 1 - usedOf(w, now))) : 1
}

// The login a reply should run on, balancing. It goes to the one with the most to spend before its budget
// resets (urgencyOf), among those not too close to a limit (ENTER_MIN left in each short window, more than
// NEARLY_OUT in the budget). `current`: the one this agent used last, kept unless another is SWITCH_RATIO
// times more urgent or it is nearly out. `prefer`: the agent's own, which wins a tie.
// A login takes over from the one in use only with SWITCH_MIN of its budget left.
// `skip`: the ones that already failed in this reply. Undefined when none is left to try.
// Only a login whose windows are known is weighed: one that never reported waits for its check. It is
// used when every known one is out, and a spent one only when there is nothing else.
export function pickLogin(logins: Login[], opts: { now: number; current?: string; prefer?: string; skip?: ReadonlySet<string> }): Login | undefined {
  const left0 = logins.filter((l) => !opts.skip?.has(l.id))
  const live = left0.filter((l) => l.windows?.length && leftOf(l, opts.now) > 0)
  const unknown = left0.filter((l) => !l.windows?.length)
  const open = live.length ? live : unknown.length ? unknown : left0
  if (!open.length) return undefined
  const left = (l: Login): number => leftOf(l, opts.now)
  const rank = (l: Login): number => (l.id === opts.prefer ? 0 : l.id === opts.current ? 1 : 2)
  if (!live.length) return open.reduce((a, b) => (left(b) > left(a) || (left(b) === left(a) && rank(b) < rank(a)) ? b : a))
  const current = live.find((l) => l.id === opts.current)
  const keep = !!current && left(current) > NEARLY_OUT
  const budgetLeft = (l: Login): number => 1 - usedOf(budgetOf(l)!, opts.now)
  const candidates = live.filter((l) => (keep && l === current) || (shortLeftOf(l, opts.now) >= ENTER_MIN && budgetLeft(l) > NEARLY_OUT))
  // None can be entered: the one with the most left, as when nothing is known of the resets.
  if (!candidates.length) return live.reduce((a, b) => (left(b) > left(a) || (left(b) === left(a) && rank(b) < rank(a)) ? b : a))
  // Against the one in use, only a login with enough left to be worth the switch is weighed.
  const pool = keep ? candidates.filter((l) => l === current || budgetLeft(l) >= SWITCH_MIN) : candidates
  const urgency = (l: Login): number => urgencyOf(l, opts.now)
  const best = pool.reduce((a, b) => {
    if (Math.abs(urgency(b) - urgency(a)) > 1e-9) return urgency(b) > urgency(a) ? b : a
    return rank(b) < rank(a) || (rank(b) === rank(a) && left(b) > left(a)) ? b : a
  })
  if (keep && current && best !== current && (urgency(current) > 0 ? urgency(best) < urgency(current) * SWITCH_RATIO : urgency(best) <= 0)) return current
  return best
}

// A Claude login that just said it hit its limit: the window that was nearly full is full until it
// resets, so the login is passed over and shows as out. When no window was near its end (a passing
// "too many requests", or nothing known yet), it sits out SPENT_MS only.
export function spentQuota(prev: Quota | undefined, now: number): Quota {
  const near = (['fiveHour', 'sevenDay'] as const).filter((k) => !!prev?.[k] && prev[k]!.utilization >= NEARLY_FULL && prev[k]!.resetsAt > now)
  const full = near.sort((a, b) => prev![b]!.utilization - prev![a]!.utilization)[0]
  if (full) return { ...prev, [full]: { utilization: 1, resetsAt: prev![full]!.resetsAt }, at: now }
  return { ...prev, fiveHour: { utilization: 1, resetsAt: now + SPENT_MS }, at: now }
}
