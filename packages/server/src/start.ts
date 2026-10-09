import { createApp } from './gateway';

// Dev/production entry: boots the room server on one HTTP port. The Vite dev
// server proxies /socket.io here; in production the same process can sit
// behind a reverse proxy.
const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.httpServer.listen(port, () => {
  console.log(`werewolf room server listening on :${port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`received ${signal}, shutting down`);
  void app.close().then(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
