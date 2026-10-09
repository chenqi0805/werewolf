import type { PlayerView } from '@werewolf/server';
import { useState } from 'react';
import type { JSX } from 'react';
import type { PlayerAction, Seat } from '@werewolf/engine';

import { emitVoiceFrame, requestStrategy, type GameSocket } from '../client/socketClient';
import { ROLE_META } from '../roles';
import type { SeatView } from '../types';
import {
  logToEntries,
  seatLabel,
  seatViewsOf,
  seerResultsOf,
  speakingSeatOf,
  speechByDayOf,
  speechMessagesOf,
} from '../client/adapters';
import { useVoiceSpeech } from '../client/useVoiceSpeech';
import {
  DayLog,
  SeatGrid,
  SeatPicker,
  SeerPad,
  SpectatorView,
  SpeechHistory,
  SpeechPanel,
  StrategyPanel,
  VotePad,
  WitchPad,
  WolfPad,
} from '../components';
import {
  actionFor,
  canSpeakNow,
  canVoteNow,
  directionNeeded,
  hunterShotState,
  nightPadKind,
  nightTargets,
  poisonTargets,
  seerTargets,
  sheriffSignupState,
  speechContextOf,
  speechSlotKeyOf,
  strategyContextOf,
  voteContextOf,
} from './gating';
import { Countdown } from './Countdown';
import { TutorialScreen } from './TutorialScreen';

interface GameScreenProps {
  view: PlayerView;
  roomCode: string;
  send: (action: PlayerAction) => void;
  /** The page's live socket — carries the seat's captured voice frames. */
  socket: GameSocket;
}

function Waiting({ note }: { note: string }): JSX.Element {
  return <p className="scr-empty">{note}</p>;
}

function CandidateList({ seats }: { seats: SeatView[] }): JSX.Element {
  if (seats.length === 0) return <p className="scr-caption">暂无候选人</p>;
  return <p className="scr-subtitle">候选人：{seats.map((s) => seatLabel(s.seat)).join('、')}</p>;
}

/**
 * The live game board: a seat grid, the current step's action pad, and the
 * running day log. Every gate and action payload comes from the pure helpers
 * in `gating.ts` — this file only arranges JSX and forwards clicks.
 */
export function GameScreen({ view, roomCode, send, socket }: GameScreenProps): JSX.Element {
  const seats: SeatView[] = seatViewsOf(view);
  const entries = logToEntries(view.log);
  const speechGroups = speechByDayOf(view.log);
  const { you } = view;
  const step = view.step;
  const [showTutorial, setShowTutorial] = useState(false);
  const seat = you.seat;

  // Voice capture runs while the current speech slot is mine: mic frames go
  // out over `voice:frame`, the joined transcript auto-submits as SPEAK one
  // second before the slot deadline. Hooks stay unconditional — the spectator
  // branch below simply never passes `canSpeak`.
  const canSpeak = canSpeakNow(view);
  const voice = useVoiceSpeech({
    canSpeak: seat !== null && canSpeak,
    slotKey: speechSlotKeyOf(view),
    deadlineAtMs: view.timer?.endsAt ?? null,
    submit: (text) => {
      if (seat !== null) send({ type: 'SPEAK', actor: seat, text });
    },
    onFrame: (chunk) => emitVoiceFrame(socket, chunk),
  });

  if (seat === null) {
    return (
      <main className="scr-page">
        <section className="scr-panel">
          <span className="scr-code">{roomCode}</span>
          <SpectatorView
            seats={seats}
            speakingSeat={speakingSeatOf(step)}
            messages={speechMessagesOf(view.log)}
            dayNumber={view.dayNumber}
            phaseCaption="观战"
          />
          <DayLog entries={entries} />
          <SpeechHistory groups={speechGroups} />
        </section>
      </main>
    );
  }

  const meta = you.role !== null ? ROLE_META[you.role] : null;
  const nightKind = nightPadKind(view);
  const signup = sheriffSignupState(view);
  const shot = hunterShotState(view);
  const votes = voteContextOf(view);
  const speechKind = speechContextOf(view);
  const strategy = strategyContextOf(view);

  function onPick(kind: 'kill' | 'poison' | 'check' | 'shoot') {
    return (target: Seat) => {
      const action = actionFor(view, kind, target);
      if (action !== null) send(action);
    };
  }

  return (
    <main className="scr-page">
      <section className="scr-panel">
        <div className="scr-row scr-row--spread">
          <div className="scr-row">
            <h1 className="scr-title">
              第 {view.dayNumber} 天 · {view.phase === 'night' ? '夜晚' : '白天'}
            </h1>
            <Countdown timer={view.timer} />
          </div>
          <div className="scr-row">
            <button type="button" onClick={() => setShowTutorial(true)}>
              玩法教程
            </button>
            <span className="scr-caption">你的座位 {seat} 号</span>
            {meta !== null && <span className="scr-badge">{meta.label}</span>}
            {you.hasBadge && <span className="scr-badge scr-badge--badge">警长</span>}
            {!you.alive && <span className="scr-badge scr-badge--dead">出局</span>}
          </div>
        </div>
        <SeatGrid seats={seats} />
        <DayLog entries={entries} />
        <SpeechHistory groups={speechGroups} />
      </section>

      {step.kind !== 'game-over' && (
        <section className="scr-panel">
          {step.kind === 'night' && nightKind === 'wolf' && you.role === 'werewolf' && (
            <WolfPad
              wolves={you.wolfPack ?? [seat]}
              targets={nightTargets(view)}
              onConfirm={(target) => send({ type: 'WOLF_KILL', actor: seat, target })}
            />
          )}
          {step.kind === 'night' && nightKind === 'witch' && you.role === 'witch' && (
            <WitchPad
              self={seat}
              killTarget={you.witchPotions?.killTarget ?? null}
              healUsed={you.witchPotions?.healUsed ?? false}
              poisonUsed={you.witchPotions?.poisonUsed ?? false}
              maySelfSave={you.witchPotions?.maySelfSave ?? false}
              targets={poisonTargets(view)}
              onHeal={() => send({ type: 'WITCH_HEAL', actor: seat })}
              onPoison={onPick('poison')}
              onSkip={() => send({ type: 'WITCH_PASS', actor: seat })}
            />
          )}
          {step.kind === 'night' && nightKind === 'seer' && you.role === 'seer' && (
            <SeerPad
              results={seerResultsOf(you)}
              targets={seerTargets(view)}
              onCheck={onPick('check')}
            />
          )}
          {step.kind === 'night' && nightKind === 'waiting' && (
            <Waiting note="夜晚进行中，等待其他玩家行动…" />
          )}

          {step.kind === 'sheriff-signup' && (
            <div>
              <CandidateList seats={signup.candidates} />
              <div className="scr-actions">
                <button
                  type="button"
                  onClick={() => send({ type: 'SHERIFF_SIGNUP', actor: seat })}
                  disabled={!signup.canSignup}
                >
                  上警
                </button>
                <button
                  type="button"
                  onClick={() => send({ type: 'SHERIFF_WITHDRAW', actor: seat })}
                  disabled={!signup.canWithdraw}
                >
                  退水
                </button>
              </div>
            </div>
          )}

          {directionNeeded(view) && (
            <div>
              <p className="scr-subtitle">警长决定发言方向：</p>
              <div className="scr-actions">
                <button
                  type="button"
                  onClick={() =>
                    send({ type: 'SET_SPEECH_DIRECTION', actor: seat, direction: 'cw' })
                  }
                >
                  顺序发言
                </button>
                <button
                  type="button"
                  onClick={() =>
                    send({ type: 'SET_SPEECH_DIRECTION', actor: seat, direction: 'ccw' })
                  }
                >
                  逆序发言
                </button>
              </div>
            </div>
          )}

          {speechKind !== null && (
            <>
              <SpeechPanel
                messages={speechMessagesOf(view.log)}
                speakingSeat={speakingSeatOf(step)}
                mySeat={seat}
                canSpeak={canSpeak}
                voice={voice}
              />
              {strategy !== null && (
                <StrategyPanel
                  role={strategy.role}
                  dayRecords={strategy.dayRecords}
                  onSuggest={() => requestStrategy(socket)}
                />
              )}
            </>
          )}

          {votes !== null && (
            <VotePad
              mode="vote"
              candidates={votes.electorate}
              canVote={canVoteNow(view)}
              voteBlockNote={!you.alive ? '你已出局，无需投票' : undefined}
              isSheriff={you.hasBadge}
              onSubmitVote={(target) => send({ type: votes.actionKind, actor: seat, target })}
            />
          )}

          {step.kind === 'hunter-shot' &&
            (shot.active ? (
              <div>
                <p className="scr-subtitle">猎人技能：选择开枪目标</p>
                <SeatPicker options={shot.targets} onSelect={onPick('shoot')} disabled={false} />
                <div className="scr-actions">
                  <button type="button" onClick={() => send({ type: 'HUNTER_PASS', actor: seat })}>
                    放弃开枪
                  </button>
                </div>
              </div>
            ) : (
              <Waiting note="猎人技能发动中…" />
            ))}

          {step.kind === 'badge-pass' && (
            <div>
              <p className="scr-subtitle">警长移交警徽</p>
              <SeatPicker
                options={seats.filter((s) => s.alive && s.seat !== seat)}
                onSelect={(target) => send({ type: 'SHERIFF_PASS', actor: seat, target })}
                disabled={false}
              />
              <div className="scr-actions">
                <button
                  type="button"
                  onClick={() => send({ type: 'SHERIFF_PASS', actor: seat, target: null })}
                >
                  撕毁警徽
                </button>
              </div>
            </div>
          )}

          {step.kind === 'dawn-announce' && <Waiting note="天亮了，正在公布昨夜消息…" />}
        </section>
      )}

      {showTutorial && <TutorialScreen modal onClose={() => setShowTutorial(false)} />}
    </main>
  );
}
