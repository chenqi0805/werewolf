import type { Camp, Role } from './types';

/**
 * Long-form tutorial copy behind the 玩法教程 screen — one guide per role.
 * Seeded from `ROLE_META` (label, team, ability) and expanded with win
 * conditions and playstyle tips for new players.
 */
export interface RoleGuide {
  role: Role;
  label: string;
  team: Camp;
  /** Win condition, phrased for someone learning the game. */
  winLine: string;
  /** How the role works, night to night. */
  ability: string;
  /** Concrete playstyle advice. */
  tips: string[];
}

const GUIDES: Record<Role, RoleGuide> = {
  werewolf: {
    role: 'werewolf',
    label: '狼人',
    team: 'wolves',
    winLine: '杀光所有村民，或杀光所有神职（预言家、女巫、猎人、白痴）—— 屠边即胜。',
    ability:
      '每晚与狼队友共同决定一名猎物：大家各自报出目标，最集中的目标被猎杀；意见分裂或多数选择空刀时，当晚平安。',
    tips: [
      '白天伪装好人身份，发言别太强势，也不要全程划水。',
      '记住队友的立场，必要时敢踩队友一口以洗清自己。',
      '悍跳预言家是经典打法：抢走真预言家的信任，带歪好人的查验方向。',
      '自刀、空刀这类骗药操作，务必提前和队友商量好。',
    ],
  },
  villager: {
    role: 'villager',
    label: '村民',
    team: 'good',
    winLine: '放逐所有狼人。',
    ability: '没有夜间技能，靠白天的发言、站边与投票守护村庄——你的武器就是逻辑和直觉。',
    tips: [
      '认真听每个人的发言，找逻辑矛盾和站边动机。',
      '敢于表达怀疑，也敢为信念站出来投票。',
      '投票前和好人阵营对齐集火目标，别让好人票分散。',
      '神职没起跳之前，你就是村庄的底气。',
    ],
  },
  seer: {
    role: 'seer',
    label: '预言家',
    team: 'good',
    winLine: '放逐所有狼人。',
    ability: '每晚查验一名玩家的阵营（狼人或好人），积累查杀与金水信息，是好人阵营的信息核心。',
    tips: [
      '白天择机起跳报查验，把查杀与金水讲清楚，给好人指方向。',
      '优先查验发言摇摆、身份模糊的人，信息收益最大。',
      '警上竞选取胜后拿到警徽，安排好验人方向与发言顺序。',
      '面对悍跳的假预言家，冷静对比双方逻辑，带好人站对边。',
    ],
  },
  witch: {
    role: 'witch',
    label: '女巫',
    team: 'good',
    winLine: '放逐所有狼人。',
    ability: '拥有一瓶解药与一瓶毒药，各限用一次；解药仅首夜可以自救。',
    tips: [
      '解药很贵：首夜通常要救下刀口，之后留给关键神职。',
      '毒药留给把握最大的狼人，宁可晚用不可乱毒。',
      '用药前把刀口与白天发言对一遍，别毒到好人。',
      '手握关键信息时择机起跳带节奏，但别暴露太早。',
    ],
  },
  hunter: {
    role: 'hunter',
    label: '猎人',
    team: 'good',
    winLine: '放逐所有狼人。',
    ability: '被狼人猎杀或被放逐出局时，可以开枪带走一名玩家；被毒杀时不能开枪。',
    tips: [
      '枪是底牌：平时隐藏身份，防止狼队刻意避刀或骗枪。',
      '开枪前冷静确认目标身份，宁可不开枪也别带走好人。',
      '被放逐时亮明身份再开枪，带枪的威胁本身就是发言筹码。',
    ],
  },
  idiot: {
    role: 'idiot',
    label: '白痴',
    team: 'good',
    winLine: '放逐所有狼人。',
    ability: '被放逐时翻牌亮明身份即可存活，但从此失去投票权，且不会再被放逐。',
    tips: [
      '翻牌后发言权还在：用发言继续影响白天的集火方向。',
      '前期可以大胆发言吸引火力，帮好人排除一个身份。',
      '记住翻牌后不能再投票，好人集火时你要靠发言拉票。',
    ],
  },
};

/** Tutorial copy in board order (狼人 first, then the good camp). */
export const ROLE_GUIDES: RoleGuide[] = Object.values(GUIDES);
