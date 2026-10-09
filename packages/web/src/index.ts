/**
 * Placeholder entry point. The React + Vite client (lobby, role card,
 * night action pads, speech chat, vote pad, day log) lands in its own PR;
 * nothing here is UI or game logic.
 */
export const APP_NAME = 'werewolf-web';

export function greeting(name: string): string {
  return `Welcome to ${APP_NAME}, ${name}`;
}
