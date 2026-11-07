export const watchReadyMessageType = 'affected-node-test:watch-ready';

export function sendWatchReady() {
  if (typeof process.send === 'function' && process.connected) {
    process.send({ type: watchReadyMessageType });
  }
}
