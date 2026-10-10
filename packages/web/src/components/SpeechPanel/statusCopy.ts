import type { VoiceSpeechState } from '../../client/voiceSession';

/**
 * zh-CN copy for each voice-composer status. `null` renders nothing — the
 * idle composer has no status line yet.
 */
export function statusCopy(state: VoiceSpeechState): string | null {
  switch (state.status) {
    case 'idle':
      return null;
    case 'requesting':
      return '正在请求麦克风…';
    case 'recording':
      return '录音中，发言结束前自动提交';
    case 'submitted':
      return '已提交';
    case 'unavailable':
      return '语音不可用';
    case 'silent':
      return '未发言';
    case 'unsupported':
      return '浏览器不支持语音转写，录音将由服务器转写';
  }
}
