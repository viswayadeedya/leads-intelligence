// Minimal robots.txt evaluation (RFC 9309 subset): user-agent groups,
// Allow/Disallow with * and $, longest match wins, Allow wins ties.
// robots.txt is an access signal we honor; it is not a permission grant.

import type { FetchOutcome } from './transport';

/** The product token this tool looks for in robots.txt (it also obeys "*"). */
export const ROBOTS_AGENT = 'opportunityintelligenceresearch';

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

export type RobotsPolicy = { isAllowed: (path: string) => boolean };

export const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };
export const DISALLOW_ALL: RobotsPolicy = { isAllowed: () => false };

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = core
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

export function parseRobots(text: string, agentToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, 100_000).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      if (value === '') continue; // empty Disallow means allow everything
      current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const token = agentToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);
  if (rules.length === 0) return ALLOW_ALL;
  const compiled = rules.map((r) => ({ ...r, re: patternToRegExp(r.pattern) }));
  return {
    isAllowed(path: string): boolean {
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of compiled) {
        if (!rule.re.test(path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) {
          best = { allow: rule.allow, length };
        }
      }
      return best ? best.allow : true;
    },
  };
}

// ---- From a fetch result to a policy: fail closed --------------------------------
//
// One function decides, for both the investigation and the transport, what an
// attempt to read robots.txt means. The rule:
//
//   file read            -> its rules apply
//   empty file (200)     -> a present file with no rules: nothing is disallowed
//   genuinely absent     -> 404 or 410 only: nothing is disallowed
//   anything else        -> the rules are UNKNOWN and nothing is fetched:
//                           401/403/407/451, 429, a bot check, a redirect to
//                           another site, any other status, a server error, a
//                           timeout, a network or TLS failure, a response that
//                           is not a rules file.

export type RobotsUnknownReason =
  | 'access_refused'
  | 'rate_limited'
  | 'bot_challenge'
  | 'redirected_elsewhere'
  | 'blocked'
  | 'server_error'
  | 'unexpected_status'
  | 'not_a_robots_file'
  | 'fetch_failed';

export type RobotsState =
  | { status: 'ok'; text: string; reason?: 'read' | 'empty'; retryable?: boolean }
  | { status: 'none'; text: null; reason?: 'absent'; retryable?: boolean }
  | { status: 'unreachable'; text: null; reason?: RobotsUnknownReason | string; retryable?: boolean };

/** Why a page was not fetched because of robots.txt. */
export type RobotsRefusal = 'robots_disallow' | 'robots_unreachable' | 'robots_restricted' | 'robots_invalid';

const looksLikeHtml = (body: string) => /^\s*(?:<!doctype|<html|<head|<body|<\?xml|<)/i.test(body.slice(0, 500)) || /<html[\s>]|<body[\s>]|<script[\s>]/i.test(body.slice(0, 5_000));

export function robotsStateFromOutcome(outcome: FetchOutcome): RobotsState {
  const unknown = (reason: RobotsUnknownReason, retryable: boolean): RobotsState => ({ status: 'unreachable', text: null, reason, retryable });
  if (outcome.kind === 'ok') {
    // A web page answering for /robots.txt (a "soft 404", a login page, a landing page) is not a rules file.
    if (looksLikeHtml(outcome.body)) return unknown('not_a_robots_file', false);
    return { status: 'ok', text: outcome.body.slice(0, 20_000), reason: 'read' };
  }
  if (outcome.kind === 'unavailable') {
    if (outcome.httpStatus === 404 || outcome.httpStatus === 410) return { status: 'none', text: null, reason: 'absent' };
    if (outcome.reason === 'empty_response' && outcome.httpStatus === 200) return { status: 'ok', text: '', reason: 'empty' };
    if (outcome.httpStatus !== null && outcome.httpStatus >= 500) return unknown('server_error', true);
    if (outcome.httpStatus !== null) return unknown('unexpected_status', false);
    return unknown('fetch_failed', outcome.retryable);
  }
  if (outcome.kind === 'restricted') {
    if (outcome.reason === 'rate_limited') return unknown('rate_limited', false);
    if (outcome.reason === 'captcha_or_bot_challenge') return unknown('bot_challenge', false);
    if (outcome.reason === 'redirected_off_domain') return unknown('redirected_elsewhere', false);
    if (outcome.reason.startsWith('robots_')) return unknown('blocked', false);
    return unknown('access_refused', false);
  }
  if (outcome.reason === 'content_type_not_allowed') return unknown('not_a_robots_file', false);
  if (outcome.reason.startsWith('security_blocked')) return unknown('blocked', false);
  return unknown('fetch_failed', outcome.retryable);
}

export function robotsPolicyFromState(state: Pick<RobotsState, 'status' | 'text'>): RobotsPolicy {
  if (state.status === 'ok') return parseRobots(state.text ?? '', ROBOTS_AGENT);
  if (state.status === 'none') return ALLOW_ALL;
  return DISALLOW_ALL;
}

/** The reason recorded on a page that robots.txt handling kept from being fetched. */
export function robotsRefusalReason(state: Pick<RobotsState, 'status' | 'reason'>): RobotsRefusal {
  if (state.status !== 'unreachable') return 'robots_disallow';
  if (state.reason === 'access_refused' || state.reason === 'rate_limited' || state.reason === 'bot_challenge' || state.reason === 'redirected_elsewhere' || state.reason === 'blocked') return 'robots_restricted';
  if (state.reason === 'not_a_robots_file' || state.reason === 'unexpected_status') return 'robots_invalid';
  return 'robots_unreachable';
}
