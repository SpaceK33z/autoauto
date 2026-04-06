import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import { Chat } from './components/Chat.tsx';

export function App() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();

  useKeyboard((key) => {
    if (key.name === 'escape') {
      renderer.destroy();
    }
  });

  return (
    <box flexDirection="column" width={width} height={height}>
      <box
        height={3}
        border
        borderStyle="rounded"
        justifyContent="center"
        alignItems="center"
      >
        <text>
          <strong>AutoAuto</strong>
        </text>
      </box>

      <Chat />
    </box>
  );
}
