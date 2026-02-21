const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

let minecraftProcess = null;

// download state for cancellation and tracking
let currentDownload = {
  controller: null,
  writer: null,
  promise: null,
  targetPath: null
};

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) { }
  return {};
}

function writeSettings(obj) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2)); } catch (e) { }
}

async function startServer(io) {
  if (minecraftProcess) {
    io.emit('console-output', '[PANEL] Error: Server is already running.');
    return;
  }

  const serverPath = path.join(__dirname, 'servers', 'survival-world');
  if (!fs.existsSync(serverPath)) {
    fs.mkdirSync(serverPath, { recursive: true });
    io.emit('console-output', '[PANEL] Created missing server directory...');
  }

  const eulaPath = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true');
  }

  const jarPath = path.join(serverPath, 'server.jar');
  if (!fs.existsSync(jarPath)) {
    const settings = readSettings();
    if (settings.selectedVersion) {
      io.emit('console-output', `[PANEL] server.jar missing; auto-installing saved version ${settings.selectedVersion}...`);
      await downloadServerJar(settings.selectedVersion, io).catch(err => {
        io.emit('console-output', `[PANEL] Auto-install failed: ${err && err.message}`);
      });
    }

    if (!fs.existsSync(jarPath)) {
      io.emit('console-output', '[PANEL] Error: server.jar missing. Select a version and Install first.');
      io.emit('require-install');
      return;
    }
  }

  minecraftProcess = spawn('java', ['-Xmx2G', '-Xms1G', '-jar', 'server.jar', 'nogui'], {
    cwd: serverPath
  });

  minecraftProcess.stdout.on('data', (data) => io.emit('console-output', data.toString()));
  minecraftProcess.stderr.on('data', (data) => io.emit('console-output', `[ERROR] ${data.toString()}`));

  minecraftProcess.on('close', (code) => {
    io.emit('console-output', `[PANEL] Server exited with code ${code}`);
    minecraftProcess = null;
  });

  return minecraftProcess;
}

function sendCommand(command) {
  if (minecraftProcess) {
    minecraftProcess.stdin.write(command + '\n');
  } else {
    console.log('No server running to receive command.');
  }
}

function stopServer() {
  if (minecraftProcess) {
    minecraftProcess.stdin.write('stop\n');
  }
}

async function downloadServerJar(versionTag, io) {
  const serverPath = path.join(__dirname, 'servers', 'survival-world');
  if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });

  const parts = versionTag.split('-', 2);
  const project = parts[0];
  const ver = parts[1];

  let fileUrl = null;
  let fileName = null;
  let expectedSha1 = null;
  let expectedSha256 = null;

  try {
    if (project === 'paper') {
      io.emit('console-output', `[INSTALL] Resolving Paper ${ver} builds...`);
      const buildsUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds`;
      io.emit('console-output', `[INSTALL] Fetching builds: ${buildsUrl}`);
      const buildsResp = await axios.get(buildsUrl);
      const buildsData = buildsResp.data;

      const buildsArr = Array.isArray(buildsData.builds) ? buildsData.builds : (Array.isArray(buildsData) ? buildsData : []);
      let downloadsData = null;
      let selectedBuild = null;

      for (let i = buildsArr.length - 1; i >= 0; --i) {
        const entry = buildsArr[i];
        const candidate = entry && (entry.build || entry) || entry;
        const downloadsInfoUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${candidate}/downloads`;
        io.emit('console-output', `[INSTALL] Checking build ${candidate}`);
        try {
          const dr = await axios.get(downloadsInfoUrl);
          if (dr && dr.status === 200 && dr.data) {
            downloadsData = dr.data;
            selectedBuild = candidate;
            break;
          }
        } catch (e) {
          // try previous build
        }
      }

      if (!downloadsData) {
        io.emit('console-output', `[INSTALL] No downloadable Paper builds found for ${ver}`);
        throw new Error('No downloadable builds');
      }

      if (downloadsData && downloadsData.downloads && downloadsData.downloads.application) {
        const app = downloadsData.downloads.application;
        fileName = app.name || app;
        expectedSha256 = app.sha256 || null;
        expectedSha1 = app.sha1 || null;
      }

      if (!fileName) fileName = `paper-${ver}-${selectedBuild}.jar`;
      fileUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${selectedBuild}/downloads/${encodeURIComponent(fileName)}`;
      io.emit('console-output', `[INSTALL] Downloading ${fileName} from build ${selectedBuild}`);

    } else if (project === 'vanilla') {
      io.emit('console-output', `[INSTALL] Resolving Vanilla ${ver} from Mojang manifest...`);
      const manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
      const manifestResp = await axios.get(manifestUrl);
      const manifest = manifestResp.data;
      const entry = (manifest.versions || []).find(v => v.id === ver);
      if (!entry) {
        io.emit('console-output', `[INSTALL] Version ${ver} not found in Mojang manifest.`);
        throw new Error('Vanilla version not found');
      }
      const versionInfoResp = await axios.get(entry.url);
      const versionInfo = versionInfoResp.data;
      if (versionInfo && versionInfo.downloads && versionInfo.downloads.server && versionInfo.downloads.server.url) {
        fileUrl = versionInfo.downloads.server.url;
        fileName = path.basename(fileUrl.split('?')[0]) || `minecraft_server.${ver}.jar`;
        expectedSha1 = versionInfo.downloads.server.sha1 || null;
        io.emit('console-output', `[INSTALL] Downloading Vanilla server ${fileName} ...`);
      } else {
        io.emit('console-output', `[INSTALL] No server download found for Vanilla ${ver}`);
        throw new Error('No vanilla download');
      }

    } else {
      io.emit('console-output', `[INSTALL] Installer supports 'paper' and 'vanilla' only (received: ${versionTag}).`);
      throw new Error('Unsupported project');
    }

    const targetPath = path.join(serverPath, 'server.jar');
    if (fs.existsSync(targetPath)) {
      try { fs.unlinkSync(targetPath); } catch (e) { }
    }

    const controller = new AbortController();
    currentDownload.controller = controller;

    io.emit('install-start');
    const resp = await axios.get(fileUrl, { responseType: 'stream', signal: controller.signal });
    const total = resp.headers['content-length'] ? parseInt(resp.headers['content-length'], 10) : null;

    const writer = fs.createWriteStream(targetPath);
    currentDownload.writer = writer;

    let received = 0;
    let lastEmitPct = -1;
    let lastEmitTime = Date.now();

    resp.data.on('data', (chunk) => {
      received += chunk.length;
      if (total) {
        const pct = Math.floor((received / total) * 100);
        if (pct !== lastEmitPct && (pct - lastEmitPct >= 2 || Date.now() - lastEmitTime >= 2000)) {
          io.emit('install-progress', pct);
          io.emit('console-output', `[INSTALL] Downloaded ${pct}%`);
          lastEmitPct = pct;
          lastEmitTime = Date.now();
        }
      } else {
        io.emit('console-output', `[INSTALL] Downloaded ${Math.floor(received / 1024)} KB`);
      }
    });

    resp.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      resp.data.on('error', reject);
    });

    if (expectedSha256 || expectedSha1) {
      io.emit('console-output', `[INSTALL] Verifying checksum...`);
      const buf = fs.readFileSync(targetPath);
      if (expectedSha256) {
        const sum = crypto.createHash('sha256').update(buf).digest('hex');
        if (sum !== expectedSha256) {
          io.emit('console-output', `[INSTALL] sha256 mismatch`);
          try { fs.unlinkSync(targetPath); } catch (e) {}
          throw new Error('Checksum mismatch');
        }
      }
      if (expectedSha1) {
        const sum = crypto.createHash('sha1').update(buf).digest('hex');
        if (sum !== expectedSha1) {
          io.emit('console-output', `[INSTALL] sha1 mismatch`);
          try { fs.unlinkSync(targetPath); } catch (e) {}
          throw new Error('Checksum mismatch');
        }
      }
      io.emit('console-output', `[INSTALL] Checksum OK`);
    }

    io.emit('install-progress', 100);
    io.emit('console-output', `[INSTALL] Download complete. server.jar installed.`);
    io.emit('install-complete');

    currentDownload.controller = null;
    currentDownload.writer = null;
    currentDownload.promise = null;
    currentDownload.targetPath = null;

    return true;
  } catch (err) {
    if (err && err.response && err.response.status) io.emit('console-output', `[INSTALL] HTTP ${err.response.status} ${err.config && err.config.url}`);
    io.emit('console-output', `[INSTALL] Error downloading: ${err && err.message}`);
    try { if (currentDownload.targetPath && fs.existsSync(currentDownload.targetPath)) fs.unlinkSync(currentDownload.targetPath); } catch (e) {}
    currentDownload.controller = null;
    currentDownload.writer = null;
    currentDownload.promise = null;
    currentDownload.targetPath = null;
    throw err;
  }
}

function cancelDownload(io) {
  if (currentDownload && currentDownload.controller) {
    try { currentDownload.controller.abort(); } catch (e) { }
    try { if (currentDownload.writer) currentDownload.writer.close(); } catch (e) {}
    if (currentDownload.targetPath && fs.existsSync(currentDownload.targetPath)) {
      try { fs.unlinkSync(currentDownload.targetPath); } catch (e) {}
    }
    currentDownload.controller = null;
    currentDownload.writer = null;
    currentDownload.promise = null;
    currentDownload.targetPath = null;
    io.emit('console-output', `[INSTALL] Download cancelled by user.`);
    io.emit('install-cancelled');
    return true;
  }
  return false;
}

module.exports = { startServer, sendCommand, stopServer, downloadServerJar, cancelDownload, readSettings, writeSettings };