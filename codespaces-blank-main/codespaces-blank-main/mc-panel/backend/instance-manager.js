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
      let selectedBuild = null;
      let app = null;
      for (let i = buildsArr.length - 1; i >= 0; --i) {
        const entry = buildsArr[i];
        if (entry && entry.downloads && entry.downloads.application) {
          selectedBuild = entry.build || entry;
          app = entry.downloads.application;
          break;
        }
      }

      if (!app) {
        io.emit('console-output', `[INSTALL] No downloadable Paper builds found for ${ver}`);
        throw new Error('No downloadable builds');
      }

      fileName = app.name || app;
      expectedSha256 = app.sha256 || null;
      expectedSha1 = app.sha1 || null;
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
            return false;
      }

    } else {
            io.emit('console-output', `[INSTALL] Installer supports 'paper' and 'vanilla' only (received: ${versionTag}).`);
            return false;
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

// Unified deployServer function for all server types
async function deployServer(type, version, io) {
  io.emit('console-output', `[DEPLOY] Initializing ${type} server deployment...`);
  
  const serverPath = path.join(__dirname, 'servers', 'survival-world');
  if (!fs.existsSync(serverPath)) {
    fs.mkdirSync(serverPath, { recursive: true });
    io.emit('console-output', `[DEPLOY] Created server directory.`);
  }

  try {
    // Determine deployment type
    if (type === 'paper') {
      return await deployPaperServer(version, serverPath, io);
    } else if (type === 'vanilla') {
      return await deployVanillaServer(version, serverPath, io);
    } else if (type === 'spigot') {
      return await deploySpigotServer(version, serverPath, io);
    } else if (type === 'snapshot') {
      return await deploySnapshotServer(version, serverPath, io);
    } else if (type === 'forge') {
      return await deployForgeServer(version, serverPath, io);
    } else if (type === 'fabric') {
      return await deployFabricServer(version, serverPath, io);
    } else if (type === 'curseforge') {
      return await deployCurseForgeModpack(version, serverPath, io);
    } else {
      throw new Error(`Unknown server type: ${type}`);
    }
  } catch (err) {
    io.emit('console-output', `[DEPLOY] ERROR: ${err.message}`);
    throw err;
  }
}

// Deploy PaperMC server
async function deployPaperServer(version, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing PaperMC ${version}...`);
  
  // Accept EULA
  const eulaPath = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true');
    io.emit('console-output', `[DEPLOY] EULA accepted.`);
  }

  // Download using existing function
  const versionTag = `paper-${version}`;
  await downloadServerJar(versionTag, io);
  
  // Save to settings
  const settings = readSettings();
  settings.selectedVersion = versionTag;
  settings.serverType = 'paper';
  writeSettings(settings);
  
  io.emit('console-output', `[DEPLOY] PaperMC ${version} deployment complete.`);
  return true;
}

// Deploy Vanilla server
async function deployVanillaServer(version, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing Vanilla ${version}...`);
  
  const eulaPath = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true');
    io.emit('console-output', `[DEPLOY] EULA accepted.`);
  }

  const versionTag = `vanilla-${version}`;
  await downloadServerJar(versionTag, io);
  
  const settings = readSettings();
  settings.selectedVersion = versionTag;
  settings.serverType = 'vanilla';
  writeSettings(settings);
  
  io.emit('console-output', `[DEPLOY] Vanilla ${version} deployment complete.`);
  return true;
}

// Deploy Spigot server (uses Paper versions)
async function deploySpigotServer(version, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing Spigot ${version}...`);
  
  const eulaPath = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true');
    io.emit('console-output', `[DEPLOY] EULA accepted.`);
  }

  // For Spigot, we use the same Paper JAR as they're compatible
  const versionTag = `paper-${version}`;
  await downloadServerJar(versionTag, io);
  
  const settings = readSettings();
  settings.selectedVersion = versionTag;
  settings.serverType = 'spigot';
  writeSettings(settings);
  
  io.emit('console-output', `[DEPLOY] Spigot ${version} deployment complete.`);
  return true;
}

// Deploy Snapshot server (Vanilla pre-release)
async function deploySnapshotServer(version, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing Snapshot ${version}...`);
  
  const eulaPath = path.join(serverPath, 'eula.txt');
  if (!fs.existsSync(eulaPath)) {
    fs.writeFileSync(eulaPath, 'eula=true');
    io.emit('console-output', `[DEPLOY] EULA accepted.`);
  }

  const versionTag = `vanilla-${version}`;
  await downloadServerJar(versionTag, io);
  
  const settings = readSettings();
  settings.selectedVersion = versionTag;
  settings.serverType = 'snapshot';
  writeSettings(settings);
  
  io.emit('console-output', `[DEPLOY] Snapshot ${version} deployment complete.`);
  return true;
}

// Deploy Forge server (with installer)
async function deployForgeServer(version, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing Forge ${version}...`);
  
  try {
    // Download Forge installer
    const installerUrl = `https://files.minecraftforge.net/maven/net/minecraftforge/forge/${version}-latest/forge-${version}-latest-installer.jar`;
    io.emit('console-output', `[DEPLOY] Downloading Forge installer...`);
    
    const installerPath = path.join(serverPath, `forge-installer-${version}.jar`);
    const resp = await axios.get(installerUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(installerPath);
    
    resp.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    io.emit('console-output', `[DEPLOY] Running Forge installer...`);
    
    // Run Forge installer
    await runForgeInstaller(installerPath, serverPath, io);
    
    const settings = readSettings();
    settings.selectedVersion = `forge-${version}`;
    settings.serverType = 'forge';
    writeSettings(settings);
    
    io.emit('console-output', `[DEPLOY] Forge ${version} deployment complete.`);
    return true;
  } catch (err) {
    io.emit('console-output', `[DEPLOY] Forge installation failed: ${err.message}`);
    throw err;
  }
}

// Deploy Fabric server (with launcher)
async function deployFabricServer(version, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing Fabric ${version}...`);
  
  try {
    // Get Fabric loader version
    const loaderResp = await axios.get('https://meta.fabricmc.net/v2/versions/loader');
    const latestLoader = loaderResp.data[0]?.version || 'latest';
    
    // Download Fabric installer
    const installerUrl = `https://meta.fabricmc.net/v2/versions/installer`;
    const installerResp = await axios.get(installerUrl);
    const installerVersion = installerResp.data[0]?.version || 'latest';
    
    const downloadUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${installerVersion}/fabric-installer-${installerVersion}.jar`;
    
    io.emit('console-output', `[DEPLOY] Downloading Fabric installer...`);
    const installerPath = path.join(serverPath, `fabric-installer-${version}.jar`);
    
    const resp = await axios.get(downloadUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(installerPath);
    
    resp.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    io.emit('console-output', `[DEPLOY] Running Fabric installer...`);
    
    // Run Fabric installer
    await runFabricInstaller(installerPath, version, serverPath, io);
    
    const settings = readSettings();
    settings.selectedVersion = `fabric-${version}`;
    settings.serverType = 'fabric';
    writeSettings(settings);
    
    io.emit('console-output', `[DEPLOY] Fabric ${version} deployment complete.`);
    return true;
  } catch (err) {
    io.emit('console-output', `[DEPLOY] Fabric installation failed: ${err.message}`);
    throw err;
  }
}

// Deploy CurseForge modpack
async function deployCurseForgeModpack(modpackId, serverPath, io) {
  io.emit('console-output', `[DEPLOY] Preparing CurseForge modpack ${modpackId}...`);
  
  try {
    // For CurseForge, we'd typically download the modpack zip
    // This is a simplified version - in production you'd make API calls to CurseForge
    
    io.emit('console-output', `[DEPLOY] Modpack ${modpackId} would be downloaded and extracted.`);
    io.emit('console-output', `[DEPLOY] Note: CurseForge API integration requires authentication token.`);
    
    // Accept EULA
    const eulaPath = path.join(serverPath, 'eula.txt');
    if (!fs.existsSync(eulaPath)) {
      fs.writeFileSync(eulaPath, 'eula=true');
    }
    
    const settings = readSettings();
    settings.selectedVersion = `curseforge-${modpackId}`;
    settings.serverType = 'curseforge';
    writeSettings(settings);
    
    io.emit('console-output', `[DEPLOY] CurseForge modpack setup ready.`);
    return true;
  } catch (err) {
    io.emit('console-output', `[DEPLOY] CurseForge deployment failed: ${err.message}`);
    throw err;
  }
}

// Run Forge installer
function runForgeInstaller(installerPath, serverPath, io) {
  return new Promise((resolve, reject) => {
    const forgeProcess = spawn('java', ['-jar', installerPath, '--installServer'], {
      cwd: serverPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    forgeProcess.stdout.on('data', (data) => {
      io.emit('console-output', `[FORGE] ${data.toString()}`);
    });
    
    forgeProcess.stderr.on('data', (data) => {
      io.emit('console-output', `[FORGE] ${data.toString()}`);
    });
    
    forgeProcess.on('close', (code) => {
      if (code === 0) {
        io.emit('console-output', `[FORGE] Installer completed successfully.`);
        // Clean up installer jar
        try { fs.unlinkSync(installerPath); } catch (e) {}
        resolve(true);
      } else {
        reject(new Error(`Forge installer exited with code ${code}`));
      }
    });
    
    forgeProcess.on('error', reject);
  });
}

// Run Fabric installer
function runFabricInstaller(installerPath, version, serverPath, io) {
  return new Promise((resolve, reject) => {
    const fabricProcess = spawn('java', [
      '-jar', 
      installerPath, 
      'server', 
      '-mcVersion', version,
      '-downloadDir', serverPath
    ], {
      cwd: serverPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    fabricProcess.stdout.on('data', (data) => {
      io.emit('console-output', `[FABRIC] ${data.toString()}`);
    });
    
    fabricProcess.stderr.on('data', (data) => {
      io.emit('console-output', `[FABRIC] ${data.toString()}`);
    });
    
    fabricProcess.on('close', (code) => {
      if (code === 0) {
        io.emit('console-output', `[FABRIC] Installer completed successfully.`);
        try { fs.unlinkSync(installerPath); } catch (e) {}
        resolve(true);
      } else {
        reject(new Error(`Fabric installer exited with code ${code}`));
      }
    });
    
    fabricProcess.on('error', reject);
  });
}

module.exports = { startServer, sendCommand, stopServer, downloadServerJar, cancelDownload, readSettings, writeSettings, deployServer };