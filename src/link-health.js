/**
 * Link health: which chain members are sitting out, and until when.
 *
 * A chain that fails over only *within* a turn is half a feature. `runCombo`
 * walks the candidates in order, so a dead head is retried, fails, fails over —
 * and then the next turn starts at the same dead head again. Every turn spends
 * one doomed request, and a refusal that is itself anti-abuse ("unapproved
 * channel", a policy block) reads that repetition as exactly what it exists to
 * catch. The cost is not only latency: it is the account.
 *
 * So a link that fails over is *benched* for a day. The next turn starts at the
 * first member that is still standing.
 *
 * Three deliberate properties:
 *
 * - **Keyed by chain + member**, not by model. `buddy/deepseek-v4.1-flash`
 *   failing in one chain says nothing about the other chain that likes it, and
 *   benching a model everywhere would silently narrow every route the user
 *   built.
 * - **Exactly 24 hours, regardless of failure kind.** The user asked for one
 *   number, and it is the right one here: a benched link resumes by itself, so
 *   the worst case of an over-long bench is a sibling model doing the work —
 *   while the worst case of an over-short bench is hammering a refused account.
 *   Erring long is the safe direction.
 * - **The bench always leaves something to try.** When every member of a chain
 *   is benched, the chain does not sit dead for a day: the bench is cleared and
 *   the walk starts at the head, which is the "down again, back to the first"
 *   case the user described. Last-resort traffic is still better than none.
 *
 * State is a plain object on disk (`link-health.json`) rather than process
 * memory, because a restart is precisely when a stale head would otherwise get
 * one more doomed request per turn.
 *
 * @module src/link-health.js
 */

/** How long a link sits out after failing over. One day, as specified. */
export const LINK_BENCH_MS = 24 * 60 * 60 * 1000

export const LINK_HEALTH_VERSION = 1

/** `chainId` + `memberId` -> one bench record. Keys are joined with a NUL so a
 *  model id containing the separator cannot collide with another pair. */
const KEY_SEPARATOR = '\u0000'

export function linkKey(chainId, memberId) {
  return `${String(chainId ?? '')}${KEY_SEPARATOR}${String(memberId ?? '')}`
}

/** Split a stored key back into its parts; `null` for anything malformed. */
export function splitLinkKey(key) {
  const text = String(key ?? '')
  const at = text.indexOf(KEY_SEPARATOR)
  if (at <= 0 || at === text.length - 1) return null
  return { chainId: text.slice(0, at), memberId: text.slice(at + 1) }
}

export function emptyLinkHealth() {
  return { version: LINK_HEALTH_VERSION, links: {} }
}

/**
 * Drop records that have expired, and records for chains/members that no longer
 * exist.
 *
 * Without the second half the file grows forever: every renamed chain and every
 * deleted member leaves a record that will never be read again. `live` is the
 * set of `chainId\0memberId` keys currently reachable, and `undefined` means
 * "cannot tell yet, only expire".
 *
 * @param {object} value - the stored state
 * @param {number} now
 * @param {Set<string>} [live]
 */
export function pruneLinkHealth(value, now, live) {
  const links = value?.links ?? {}
  const kept = {}
  for (const [key, record] of Object.entries(links)) {
    if (record === null || typeof record !== 'object') continue
    if (!(Number(record.until) > now)) continue
    if (live !== undefined && !live.has(key)) continue
    kept[key] = record
  }
  return { version: LINK_HEALTH_VERSION, links: kept }
}

/**
 * Which members of this chain are currently benched.
 *
 * @param {object} value - the stored state
 * @param {string} chainId
 * @param {number} now
 * @returns {Set<string>} benched member ids
 */
export function benchedMembers(value, chainId, now) {
  const prefix = `${String(chainId ?? '')}${KEY_SEPARATOR}`
  const out = new Set()
  for (const [key, record] of Object.entries(value?.links ?? {})) {
    if (!key.startsWith(prefix)) continue
    if (!(Number(record?.until) > now)) continue
    out.add(key.slice(prefix.length))
  }
  return out
}

/**
 * Order a chain's candidates so the turn starts at the first one still standing.
 *
 * This is the whole point of the module: `fallback` used to hand back the stored
 * order every turn, so a benched head was retried forever. Benched links move to
 * the back rather than being removed — if every link is benched, the ordering
 * degrades to "ask them all again", which is the last-resort behaviour we want,
 * and the chain-level failure message can still name every candidate it tried.
 *
 * Relative order is preserved on both sides of the split: the healthy links keep
 * their configured ladder order (that is the user's quality ranking), and the
 * benched ones keep theirs (so a partially-recovered chain still tries its best
 * first).
 *
 * @param {Array<object>} members - resolved candidate rows, in configured order
 * @param {Set<string>} benched - ids to demote
 * @returns {Array<object>}
 */
export function preferHealthy(members, benched) {
  if (!(benched instanceof Set) || benched.size === 0) return members
  const healthy = []
  const resting = []
  for (const member of members) {
    if (benched.has(member.id)) resting.push(member)
    else healthy.push(member)
  }
  // Everything is benched: return the configured order unchanged, and let the
  // caller decide to retire the bench (see `shouldRetireBench`).
  if (healthy.length === 0) return members
  return [...healthy, ...resting]
}

/**
 * Whether a turn should clear this chain's bench instead of using it.
 *
 * True when the chain has candidates but every one of them is benched. Trying
 * them again is the lesser evil: the alternative is a chain that refuses to make
 * any request at all for the rest of the day, including the case where the
 * failures were transient and the upstreams have long since recovered.
 *
 * @param {Array<object>} members
 * @param {Set<string>} benched
 */
export function shouldRetireBench(members, benched) {
  if (!(benched instanceof Set) || benched.size === 0) return false
  if (members.length === 0) return false
  return members.every(member => benched.has(member.id))
}
