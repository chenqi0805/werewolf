import type { Camp, Role } from './types';

export interface RoleMeta {
  label: string;
  /** Single-character monogram for chips and tight spots. */
  monogram: string;
  team: Camp;
  /** One-line ability summary shown on the role card. */
  ability: string;
  /** Name of the CSS custom property carrying this role's accent color. */
  accent: string;
}

export const ROLE_META: Record<Role, RoleMeta> = {
  werewolf: {
    label: '狼人',
    monogram: '狼',
    team: 'wolves',
    ability: '每晚与同伴共同猎杀一名玩家；白天发言或警长竞选期间可自爆，立即结束白天。',
    accent: '--role-wolf',
  },
  white_wolf_king: {
    label: '白狼王',
    monogram: '王',
    team: 'wolves',
    ability: '自爆带走一名玩家，白天发言或被放逐结算时可发动；被毒杀或夜杀则失效。',
    accent: '--role-wolf',
  },
  villager: {
    label: '村民',
    monogram: '民',
    team: 'good',
    ability: '没有技能，用白天发言与投票守护村庄。',
    accent: '--role-villager',
  },
  seer: {
    label: '预言家',
    monogram: '预',
    team: 'good',
    ability: '每晚查验一名玩家的阵营：狼人或好人。',
    accent: '--role-seer',
  },
  witch: {
    label: '女巫',
    monogram: '巫',
    team: 'good',
    ability: '一瓶解药一瓶毒药，各能用一次；仅首夜可以自救。',
    accent: '--role-witch',
  },
  hunter: {
    label: '猎人',
    monogram: '猎',
    team: 'good',
    ability: '被狼杀或被放逐时可开枪带走一人；被毒杀时不能开枪。',
    accent: '--role-hunter',
  },
  guard: {
    label: '守卫',
    monogram: '守',
    team: 'good',
    ability: '每晚守护一名玩家免受狼刀；不能连续两晚守护同一人，同守同救则奶穿。',
    accent: '--role-seer',
  },
  idiot: {
    label: '白痴',
    monogram: '痴',
    team: 'good',
    ability: '被放逐时翻牌存活并失去投票权，此后不会再被放逐。',
    accent: '--role-idiot',
  },
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && value in ROLE_META;
}
