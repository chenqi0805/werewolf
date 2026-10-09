import { APP_NAME } from './index';

// Minimal component shell: exists so the React JSX toolchain is exercised
// by typecheck from day one. The real client UI lands in its own PR.
export function App() {
  return (
    <main>
      <h1>{APP_NAME}</h1>
    </main>
  );
}
