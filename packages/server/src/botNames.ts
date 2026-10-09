/**
 * The bot nickname pool — server-picked Chinese names for AI players.
 * Names are unique within a room and drawn in pool order, so a table of
 * bots reads naturally (阿明, 小红, …) and a restored room re-draws the
 * same names for the same seat order.
 */
export const BOT_NICKNAMES = [
  '阿明',
  '小红',
  '阿强',
  '小芳',
  '阿杰',
  '小丽',
  '阿伟',
  '小燕',
  '阿军',
  '小静',
  '阿涛',
  '小婷',
] as const;

/** First pool name not yet used in the room; seats can never exceed 12. */
export function pickBotNickname(used: ReadonlySet<string>): string {
  for (const name of BOT_NICKNAMES) {
    if (!used.has(name)) return name;
  }
  throw new Error('bot nickname pool exhausted — impossible below 13 bots');
}
