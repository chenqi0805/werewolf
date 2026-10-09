import { describe, expect, it } from 'vitest';

import type { VoiceSpeechState } from '../../client/voiceSession';
import { statusCopy } from './statusCopy';

const stateOf = (
  status: VoiceSpeechState['status'],
  error: string | null = null,
): VoiceSpeechState => ({
  status,
  interimText: '',
  finalText: '',
  error,
});

describe('statusCopy', () => {
  it('names every composer status in zh-CN', () => {
    expect(statusCopy(stateOf('requesting'))).toBe('正在请求麦克风…');
    expect(statusCopy(stateOf('recording'))).toBe('录音中，发言结束前自动提交');
    expect(statusCopy(stateOf('submitted'))).toBe('已提交');
    expect(statusCopy(stateOf('unavailable'))).toBe('语音不可用');
    expect(statusCopy(stateOf('silent'))).toBe('未发言');
    expect(statusCopy(stateOf('unsupported'))).toBe('浏览器不支持语音转写，录音将由服务器转写');
  });

  it('renders nothing while idle', () => {
    expect(statusCopy(stateOf('idle'))).toBeNull();
  });
});
