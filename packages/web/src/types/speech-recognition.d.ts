/**
 * Minimal Web Speech API declarations for the voice composer.
 *
 * The web tsconfig sets `"types": []` and TypeScript's DOM lib ships no
 * SpeechRecognition surface, so the slice the composer uses is declared here
 * (MDN: Web Speech API — SpeechRecognition). Only what `useVoiceSpeech`
 * drives is typed; the rest stays out.
 */

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  /** Machine code, e.g. `not-allowed`, `network`, `no-speech`. */
  readonly error: string;
  readonly message: string;
}

declare class SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface Window {
  /** Chrome/Edge expose the engine behind the prefixed name. */
  webkitSpeechRecognition?: typeof SpeechRecognition;
}
