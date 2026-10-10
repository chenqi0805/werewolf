import type { Role } from '@werewolf/engine';

/**
 * The suite drives the real UI through its accessibility surface — aria-labels
 * and button text are the stable contract the components already ship. These
 * constants keep the Chinese labels in one place.
 */

/** Role badge text (ROLE_META.label) → engine role. */
export const ROLE_LABELS: Record<string, Role> = {
  狼人: 'werewolf',
  村民: 'villager',
  预言家: 'seer',
  女巫: 'witch',
  猎人: 'hunter',
  守卫: 'guard',
  白狼王: 'white_wolf_king',
  白痴: 'idiot',
};

/** Winner banner text → engine winner side. */
export const WINNER_LABELS: Record<string, 'wolves' | 'good'> = {
  狼人阵营胜利: 'wolves',
  好人阵营胜利: 'good',
};

export const SELECTORS = {
  createRoomButton: 'button:has-text("创建房间")',
  joinRoomButton: 'button:has-text("加入房间")',
  roomCodeInput: 'input[aria-label="房间号"]',
  roomCode: '.scr-code',
  lobbyCount: '.scr-caption:has-text("人已入座")',
  startButton: 'button:has-text("开始游戏")',
  quitButton: 'button:has-text("退出房间")',
  exitButton: 'button:has-text("返回主页")',
  seatCaption: '.scr-caption:has-text("你的座位")',
  roleBadge: '.scr-badge',
  gameOver: 'section[aria-label="游戏结束"]',
  wolfPad: 'section[aria-label="狼人行动"]',
  witchPad: 'section[aria-label="女巫用药"]',
  seerPad: 'section[aria-label="预言家查验"]',
  votePad: 'section[aria-label="放逐投票"]',
  speechPanel: 'section[aria-label="发言"]',
  seatPickerGroup: '[role="group"][aria-label="选择目标"]',
  targetPickerChip: '[role="group"][aria-label="选择目标"] button[aria-pressed]',
  hunterShotPrompt: ':text("猎人技能：选择开枪目标")',
  hunterPassButton: 'button:has-text("放弃开枪")',
  badgePassPrompt: ':text("警长移交警徽")',
  badgeDestroyButton: 'button:has-text("撕毁警徽")',
  signupButton: 'button:has-text("上警")',
  directionPrompt: ':text("警长决定发言方向")',
  guardPad: 'section[aria-label="守卫守护"]',
  destructControl: 'section[aria-label="白狼王自爆"]',
  addBotButton: 'button:has-text("添加AI玩家")',
  boardOptionWolfKing: 'button.scr-board-option:has-text("白狼王局")',
  inviteGroup: '[aria-label="邮件邀请"]',
  postgameSection: 'section[aria-label="本场复盘"]',
  voteHistory: 'section[aria-label="每轮票形"]',
  postgameGrid: '[aria-label="全场数据"]',
  postgameAskButton: 'button:has-text("生成复盘")',
  postgameReview: ':text("关键节点")',
  postgameUnconfigured: ':text("本服未开启 AI 复盘")',
} as const;

/** Seat number carried in a chip's aria-label (`"3号 名字…"`). */
export function seatOfChipLabel(label: string | null): number | null {
  const match = label?.match(/^(\d+)号/u);
  return match ? Number(match[1]) : null;
}

/** `第 2 天 · 夜晚|白天` → day number, or null off the game screen. */
export function dayOfTitle(title: string | null): number | null {
  const match = title?.match(/第 (\d+) 天/u);
  return match ? Number(match[1]) : null;
}
