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

/**
 * C — 预女猎守 board, deterministic beats:
 * night 1 the guard covers the wolf knife (平安夜); day 1 the 白狼王
 * self-destructs taking the hunter, whose shot still lands on a wolf; night 2
 * the same knife lands because 连守 forbids the repeat protect; day 2–3 the
 * table's vote majority exiles the remaining wolves — a good win.
 */
export function wolfKingPlan(roles: Map<Seat, Role>): PlayPlan {
  const ofRole = (seats: number[], role: Role): number[] =>
    seats.filter((seat) => roles.get(seat) === role);
  const villagers = [...roles.entries()]
    .filter(([, role]) => role === 'villager')
    .map(([seat]) => seat)
    .sort((a, b) => a - b);
  const knife = villagers[0] ?? -1; // nights 1–2 target the same villager

  return {
    wolfKill: (day, targets) => {
      if (day <= 2 && targets.includes(knife)) return knife;
      return ofRole(targets, 'villager')[0] ?? fail('no villager to kill');
    },
    guardProtect: (day, targets, banned) => {
      // Night 1 covers the knife — the save. Later nights: cover a god and
      // never a villager (first ascending, skipping the banned seat) so the
      // script's fate table stays deterministic — the knife always lands on
      // the next villager.
      if (day === 1) {
        return targets.includes(knife) ? knife : fail('guard cannot cover the knife');
      }
      return targets.find((t) => t !== banned && roles.get(t) !== 'villager') ?? null;
    },
    witch: () => ({ kind: 'pass' }),
    seerCheck: (_day, targets) => targets[0] ?? fail('seer has no unchecked target'),
    sheriffCandidates: [],
    speech: () => '过',
    exileVote: (seat, _day, candidates) => {
      if (roles.get(seat) === 'werewolf' || roles.get(seat) === 'white_wolf_king') {
        return (
          ofRole(candidates, 'villager')[0] ??
          ofRole(candidates, 'seer')[0] ??
          ofRole(candidates, 'witch')[0] ??
          ofRole(candidates, 'guard')[0] ??
          ofRole(candidates, 'hunter')[0] ??
          null
        );
      }
      return ofRole(candidates, 'werewolf')[0] ?? null;
    },
    hunterShot: (_day, targets) => ofRole(targets, 'werewolf')[0] ?? null,
    destruct: (day, targets) => {
      // Day 1: blast taking the hunter — the taken hunter still shoots.
      if (day === 1) return ofRole(targets, 'hunter')[0] ?? null;
      return null;
    },
    badgePass: () => null,
  };
}

/**
 * D — bot-mix: the humans sit back while the scripted brains play the table.
 * Human wolves still vote the first living target so the pack's knife lands;
 * everything else stays passive and the game must finish on the bots alone.
 */
export function botMixPlan(): PlayPlan {
  return {
    wolfKill: (_day, targets) => targets[0] ?? null,
    guardProtect: (_day, targets) => targets[0] ?? null,
    witch: () => ({ kind: 'pass' }),
    seerCheck: (_day, targets) => targets[0] ?? fail('seer has no unchecked target'),
    sheriffCandidates: [],
    speech: () => '过',
    exileVote: () => null,
    hunterShot: () => null,
    destruct: () => null,
    badgePass: () => null,
  };
}

/**
 * E — 竞选局: one human host sits with eleven scripted bots, and the dealt
 * seer runs for sheriff — a scripted seer signs up by itself, and if the
 * host holds the seer the plan raises her hand instead. The 警下 bots back
 * the lowest candidate, so the election lands deterministically. The first
 * knife is saved (the scripted witch does the same) so the seer always
 * survives to her podium, and her own exile ballot votes so the public
 * tally carries the sheriff's 1.5-weight vote.
 */
export function electionPlan(roles: Map<Seat, Role>): PlayPlan {
  const seer = [...roles.entries()].find(([, role]) => role === 'seer')?.[0];
  return {
    wolfKill: (_day, targets) => targets[0] ?? null,
    witch: (day, victim) => (day === 1 && victim !== null ? { kind: 'heal' } : { kind: 'pass' }),
    seerCheck: (_day, targets) => targets[0] ?? fail('seer has no unchecked target'),
    sheriffCandidates: seer === undefined ? [] : [seer],
    speech: () => '过',
    sheriffVote: () => null, // the host abstains; the scripted 警下 elect the seer
    exileVote: (seat, _day, candidates) =>
      seer !== undefined && seat === seer ? (candidates[0] ?? null) : null,
    hunterShot: () => null,
    badgePass: () => null,
  };
}

function fail(why: string): number {
  throw new Error(`plan dead-end: ${why}`);
}
