// Minimal robots.txt evaluation (RFC 9309 subset): user-agent groups,
// Allow/Disallow with * and $, longest match wins, Allow wins ties.
// robots.txt is an access signal we honor; it is not a permission grant.

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
