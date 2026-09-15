import { DEFAULT_SETTING_VALUE, SettingValue } from './notification-events';

// The two routing decisions, with no database in sight. Both are pure so the
// precedence rules can be tested directly instead of inferred from whatever
// arrived in Slack.

export interface RuleRow {
  channelId: string;
  scopeType: string;
  events: unknown;
  mode: string;
}

export interface SettingRow {
  userId: string;
  scopeType: string;
  value: string;
}

const RULE_SPECIFICITY: Record<string, number> = { org: 0, project: 1 };
const SETTING_SPECIFICITY: Record<string, number> = { global: 0, org: 1, project: 2 };

function ruleRank(scopeType: string): number {
  return RULE_SPECIFICITY[scopeType] ?? 2;
}

function settingRank(scopeType: string): number {
  return SETTING_SPECIFICITY[scopeType] ?? 3;
}

// Rules add up as you walk out to the org, except that the most specific rule
// for a given channel decides whether that channel hears about it at all. A
// deployment-level mute therefore beats an org-level deliver, which is what
// lets one flapping app be silenced without unpicking the team's setup.
export function resolveRuleLane(rules: RuleRow[], event: string): string[] {
  const best = new Map<string, { rank: number; mode: string }>();
  for (const rule of rules) {
    const events = Array.isArray(rule.events) ? (rule.events as string[]) : [];
    if (!events.includes(event)) continue;
    const rank = ruleRank(rule.scopeType);
    const current = best.get(rule.channelId);
    if (!current || rank > current.rank || (rank === current.rank && rule.mode === 'mute')) {
      best.set(rule.channelId, { rank, mode: rule.mode });
    }
  }
  return [...best.entries()].filter(([, v]) => v.mode !== 'mute').map(([channelId]) => channelId);
}

// Straight "most specific wins" over global -> org -> project -> resource, with
// the system default standing in when a user has never expressed an opinion.
export function resolveSettingValue(settings: SettingRow[], userId: string): SettingValue {
  let best: { rank: number; value: SettingValue } | null = null;
  for (const s of settings) {
    if (s.userId !== userId) continue;
    const rank = settingRank(s.scopeType);
    if (!best || rank > best.rank) best = { rank, value: s.value as SettingValue };
  }
  return best?.value ?? DEFAULT_SETTING_VALUE;
}

export interface InvolvementContext {
  actorUserId: string | null;
  resourceCreatorId: string | null;
  projectOwnerId: string | null;
}

export function isInvolved(userId: string, ctx: InvolvementContext): boolean {
  return (
    userId === ctx.actorUserId || userId === ctx.resourceCreatorId || userId === ctx.projectOwnerId
  );
}

export function shouldNotifyUser(
  userId: string,
  settings: SettingRow[],
  ctx: InvolvementContext
): boolean {
  const value = resolveSettingValue(settings, userId);
  if (value === 'never') return false;
  if (value === 'always') return true;
  return isInvolved(userId, ctx);
}
