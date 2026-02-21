const im = require('./codespaces-blank-main/codespaces-blank-main/mc-panel/backend/instance-manager');

// Simple io stub that forwards emits to console
const io = {
  emit: (...args) => console.log('[IO]', ...args)
};

(async () => {
  try {
    console.log('Starting test download: vanilla-1.20.1');
    const ok = await im.downloadServerJar('vanilla-1.20.1', io);
    console.log('Download result:', ok);
  } catch (e) {
    console.error('Test failed:', e && e.message);
    process.exit(1);
  }
})();
