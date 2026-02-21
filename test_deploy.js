const im = require('./codespaces-blank-main/codespaces-blank-main/mc-panel/backend/instance-manager');

const io = { emit: (...args) => console.log('[IO]', ...args) };

(async () => {
  try {
    console.log('Starting deployServer vanilla-1.20.1');
    const ok = await im.deployServer('vanilla', '1.20.1', io);
    console.log('deployServer result:', ok);
  } catch (e) {
    console.error('deployServer failed:', e && e.message);
    process.exit(1);
  }
})();
