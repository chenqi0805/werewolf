import type { JSX } from 'react';
import type { Decorator, Preview } from '@storybook/react';

import '../src/design/tokens.css';
import '../src/design/global.css';

export type ThemeGlobal = 'light' | 'dark';

/**
 * Wraps every story in the themed scope. Both themes read from the same token
 * set: `data-theme` on the wrapper flips the overrides without touching
 * documentElement, so parallel story isolation stays intact.
 */
const withTheme: Decorator = (Story, context) => {
  const theme: ThemeGlobal = context.globals.theme === 'dark' ? 'dark' : 'light';
  return (
    <div className="theme-scope" data-theme={theme} style={{ minHeight: '100vh', padding: 24 }}>
      <Story />
    </div>
  ) as JSX.Element;
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Design token theme — day board or night board',
      toolbar: {
        title: '主题',
        icon: 'mirror',
        items: [
          { value: 'light', icon: 'sun', title: '白天' },
          { value: 'dark', icon: 'moon', title: '夜晚' },
        ],
      },
    },
  },
  initialGlobals: {
    theme: 'light',
  },
  parameters: {
    layout: 'padded',
  },
};

export default preview;
