import type { Role, Seat } from '@werewolf/engine';

import type { PlayPlan } from './driver';

/**
 * Scenario plans. Each closes over the dealt roles (discovered at the table)
 * and chooses only among the chips its pads actually offer, so a plan can
 * never target a dead or ineligible seat — the picker lists the living only.
 */

/**
 * A — wolves knife one villager per night while the table abstains every day:
 * 屠边 on the villagers ends it as a wolf win after night 4.
 */
export function wolfWinPlan(roles: Map<Seat, Role>): PlayPlan {
  return {
    wolfKill: (_day, targets) => targets.find((t) => roles.get(t) === 'villager') ?? null,
    witch: () => ({ kind: 'pass' }),
    seerCheck: (_day, targets) => targets[0] ?? fail('seer has no unchecked target'),
    sheriffCandidates: [],
    speech: () => '过',
    exileVote: () => null, // the whole table abstains: no exile, no PK
    hunterShot: () => null, // no hunter dies under this script
    badgePass: () => null,
  };
}

/**
 * B — good wins: the witch poisons a wolf on night 1, day 1 exiles the idiot
 * (reveal, survives, loses votes), night 2 the wolves kill the hunter, whose
 * shot takes a second wolf, and the exile votes finish the pack.
 */
export function goodWinPlan(roles: Map<Seat, Role>): PlayPlan {
  const idiot = [...roles.entries()].find(([, role]) => role === 'idiot')?.[0];
  const ofRole = (seats: number[], role: Role): number[] =>
    seats.filter((seat) => roles.get(seat) === role);

  return {
    wolfKill: (day, targets) => {
      // Night 1 takes a villager; night 2 takes the hunter (his shot is the
      // script's beat); after that the knife grinds villagers — the win then
      // lands on exile votes while the idiot is still alive for the reveal.
      if (day === 1) return ofRole(targets, 'villager')[0] ?? fail('no villager to kill');
      if (day === 2) return ofRole(targets, 'hunter')[0] ?? fail('no hunter to kill');
      return ofRole(targets, 'villager')[0] ?? fail('no villager to kill');
    },
    witch: (day, _victim, targets) => {
      if (day !== 1) return { kind: 'pass' };
      const wolf = ofRole(targets, 'werewolf')[0];
      return wolf === undefined ? { kind: 'pass' } : { kind: 'poison', target: wolf };
    },
    seerCheck: (_day, targets) => targets[0] ?? fail('seer has no unchecked target'),
    sheriffCandidates: [], // the election voids: 本局无警长
    speech: () => '过',
    exileVote: (seat, day, candidates) => {
      if (roles.get(seat) === 'werewolf') {
        // Wolves vote a non-idiot good seat — never pad the idiot's tally.
        return (
          candidates.find((c) => {
            const role = roles.get(c);
            return role !== undefined && role !== 'werewolf' && role !== 'idiot';
          }) ?? null
        );
      }
      if (day === 1) {
        // The table exiles the idiot: he flips, survives, loses vote rights.
        if (idiot !== undefined && candidates.includes(idiot)) return idiot;
      }
      return ofRole(candidates, 'werewolf')[0] ?? null;
    },
    hunterShot: (_day, targets) => ofRole(targets, 'werewolf')[0] ?? null,
    badgePass: () => null,
  };
}

function fail(why: string): number {
  throw new Error(`plan dead-end: ${why}`);
}
