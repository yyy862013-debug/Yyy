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
    // GUARD: Prevent Issue #4 (Multiple Instances)
    if (minecraftProcess) {
        io.emit('console-output', '[PANEL] Error: Server is already running.');
        return;
    }

    const serverPath = path.join(__dirname, 'servers', 'survival-world');

    // FIX: Issue #2 (Directory Verification)
    if (!fs.existsSync(serverPath)) {
        fs.mkdirSync(serverPath, { recursive: true });
        io.emit('console-output', '[PANEL] Created missing server directory...');
    }


    // Auto-accept EULA
    const eulaPath = path.join(serverPath, 'eula.txt');
    if (!fs.existsSync(eulaPath)) {
        fs.writeFileSync(eulaPath, 'eula=true');
    }

    // Ensure server.jar exists before attempting to start
    const jarPath = path.join(serverPath, 'server.jar');
    if (!fs.existsSync(jarPath)) {
        // Try auto-install if we have a saved selectedVersion
        const settings = readSettings();
        if (settings.selectedVersion) {
            io.emit('console-output', `[PANEL] server.jar missing; auto-installing saved version ${settings.selectedVersion}...`);
            await downloadServerJar(settings.selectedVersion, io);
        }

        if (!fs.existsSync(jarPath)) {
            io.emit('console-output', '[PANEL] Error: server.jar missing. Select a version and Install first.');
            io.emit('require-install');
            return;
        }
    }

    // Spawn the process
    minecraftProcess = spawn('java', ['-Xmx2G', '-Xms1G', '-jar', 'server.jar', 'nogui'], { 
        cwd: serverPath 
    });

    // FIX: Issue #3 (Incomplete Stream Handling - added stderr)
    minecraftProcess.stdout.on('data', (data) => io.emit('console-output', data.toString()));
    minecraftProcess.stderr.on('data', (data) => io.emit('console-output', `[ERROR] ${data.toString()}`));

    // FIX: Issue #1 (Zombie Processes - cleanup on exit)
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
        console.log("No server running to receive command.");
    }
}

// NEW: Proper Stop Function
function stopServer() {
    if (minecraftProcess) {
        minecraftProcess.stdin.write('stop\n');
    }
}

// Download server.jar from PaperMC API and stream to server directory
async function downloadServerJar(versionTag, io) {
    const serverPath = path.join(__dirname, 'servers', 'survival-world');
    if (!fs.existsSync(serverPath)) fs.mkdirSync(serverPath, { recursive: true });

    // Expect versionTag like 'paper-1.21' or 'paper-1.20.4'
    const parts = versionTag.split('-', 2);
    const project = parts[0];
    const ver = parts[1];

    // Support Paper (via PaperMC) and Vanilla (via Mojang manifest)
    let fileUrl = null;
    let fileName = null;
    if (project === 'paper') {
        io.emit('console-output', `[INSTALL] Resolving Paper ${ver} latest build...`);

        const buildsUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds`;
        const buildsResp = await axios.get(buildsUrl);
        const buildsData = buildsResp.data;

        let buildNum = null;
        if (Array.isArray(buildsData.builds) && buildsData.builds.length) {
            // builds may be array of objects with 'build' property
            const last = buildsData.builds[buildsData.builds.length - 1];
            buildNum = last.build || last;
        } else if (Array.isArray(buildsData) && buildsData.length) {
            buildNum = buildsData[buildsData.length - 1];
        }

        if (!buildNum) {
            io.emit('console-output', `[INSTALL] No builds found for Paper ${ver}`);
            return;
        }

        // Get download info to determine filename
        const downloadsInfoUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${buildNum}/downloads`;
        const downloadsResp = await axios.get(downloadsInfoUrl);
        const downloadsData = downloadsResp.data;

        // Try to find application filename
        if (downloadsData && downloadsData.downloads && downloadsData.downloads.application) {
            const app = downloadsData.downloads.application;
            fileName = app.name || app;
        }

        if (!fileName && downloadsData && downloadsData.application) fileName = downloadsData.application;
        if (!fileName) fileName = `paper-${ver}-${buildNum}.jar`;

        fileUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${buildNum}/downloads/${fileName}`;
        io.emit('console-output', `[INSTALL] Downloading ${fileName} ...`);

    } else if (project === 'vanilla') {
        // Mojang version manifest flow
        try {
            io.emit('console-output', `[INSTALL] Resolving Vanilla ${ver} from Mojang manifest...`);
            const manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
            const manifestResp = await axios.get(manifestUrl);
            const manifest = manifestResp.data;
            const entry = (manifest.versions || []).find(v => v.id === ver);
            if (!entry) {
                io.emit('console-output', `[INSTALL] Version ${ver} not found in Mojang manifest.`);
                return;
            }
            const versionInfoResp = await axios.get(entry.url);
            const versionInfo = versionInfoResp.data;
            if (versionInfo && versionInfo.downloads && versionInfo.downloads.server && versionInfo.downloads.server.url) {
                fileUrl = versionInfo.downloads.server.url;
                fileName = path.basename(fileUrl.split('?')[0]) || `minecraft_server.${ver}.jar`;
                io.emit('console-output', `[INSTALL] Downloading Vanilla server ${fileName} ...`);
            } else {
                io.emit('console-output', `[INSTALL] No server download found for Vanilla ${ver}`);
                return;
            }
        } catch (err) {
            io.emit('console-output', `[INSTALL] Error resolving Vanilla ${ver}: ${err.message}`);
            return;
        }

    } else {
        io.emit('console-output', `[INSTALL] Installer supports 'paper' and 'vanilla' only (received: ${versionTag}).`);
        return;
    }
    try {
        io.emit('console-output', `[INSTALL] Resolving Paper ${ver} latest build...`);

        const buildsUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds`;
        const buildsResp = await axios.get(buildsUrl);
        const buildsData = buildsResp.data;

        let buildNum = null;
        if (Array.isArray(buildsData.builds) && buildsData.builds.length) {
            // builds may be array of objects with 'build' property
            const last = buildsData.builds[buildsData.builds.length - 1];
            buildNum = last.build || last;
        } else if (Array.isArray(buildsData) && buildsData.length) {
            buildNum = buildsData[buildsData.length - 1];
        }

        if (!buildNum) {
            io.emit('console-output', `[INSTALL] No builds found for Paper ${ver}`);
            return;
        }

        // Get download info to determine filename
        const downloadsInfoUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${buildNum}/downloads`;
        const downloadsResp = await axios.get(downloadsInfoUrl);
        const downloadsData = downloadsResp.data;

        // Try to find application filename
        let fileName = null;
        if (downloadsData && downloadsData.downloads && downloadsData.downloads.application) {
            const app = downloadsData.downloads.application;
            fileName = app.name || app;
        }

        if (!fileName && downloadsData && downloadsData.application) fileName = downloadsData.application;
        if (!fileName) fileName = `paper-${ver}-${buildNum}.jar`;

        const fileUrl = `https://api.papermc.io/v2/projects/paper/versions/${ver}/builds/${buildNum}/downloads/${fileName}`;
        io.emit('console-output', `[INSTALL] Downloading ${fileName} ...`);

        const targetPath = path.join(serverPath, 'server.jar');
        if (fs.existsSync(targetPath)) {
            try { fs.unlinkSync(targetPath); } catch (e) { /* ignore */ }
        }

        // Prepare abort controller for cancellation
        const controller = new AbortController();
        currentDownload.controller = controller;

        const resp = await axios.get(fileUrl, { responseType: 'stream', signal: controller.signal });
        const total = resp.headers['content-length'] ? parseInt(resp.headers['content-length'], 10) : null;

        const writer = fs.createWriteStream(targetPath);
        currentDownload.writer = writer;
        currentDownload.targetPath = targetPath;

        let received = 0;
        let lastEmit = 0;
        let lastEmitTime = Date.now();
        const emitProgress = (pct) => {
            const now = Date.now();
            if (pct - lastEmit >= 2 || now - lastEmitTime >= 2000) {
                io.emit('install-progress', pct);
                lastEmit = pct;
                lastEmitTime = now;
            }
        };

        resp.data.on('data', (chunk) => {
            received += chunk.length;
            if (total) {
                const pct = Math.floor((received / total) * 100);
                io.emit('console-output', `[INSTALL] Downloaded ${pct}%`);
                if (pct !== lastEmit) emitProgress(pct);
            } else {
                io.emit('console-output', `[INSTALL] Downloaded ${Math.floor(received / 1024)} KB`);
            }
        });

        // notify frontend install started
        io.emit('install-start');

        resp.data.pipe(writer);

        currentDownload.promise = new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            resp.data.on('error', reject);
        });

        await currentDownload.promise;

        // compute checksum if available (sha1 or sha256)
        let expectedSha1 = null;
        let expectedSha256 = null;
        try {
            if (downloadsData && downloadsData.downloads && downloadsData.downloads.application) {
                const app = downloadsData.downloads.application;
                expectedSha1 = app.sha1 || app.sha256 && null;
                expectedSha256 = app.sha256 || null;
            }
            // For vanilla the versionInfo provided earlier may have server.sha1
        } catch (e) { }

        // If Vanilla flow set expected from versionInfo
        if (!expectedSha1 && project === 'vanilla') {
            try {
                // fetch version info again to read sha1 if available
                const manifestUrl = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
                const manifestResp = await axios.get(manifestUrl);
                const manifest = manifestResp.data;
                const entry = (manifest.versions || []).find(v => v.id === ver);
                if (entry) {
                    const versionInfoResp = await axios.get(entry.url);
                    const versionInfo = versionInfoResp.data;
                    if (versionInfo && versionInfo.downloads && versionInfo.downloads.server) {
                        expectedSha1 = versionInfo.downloads.server.sha1 || expectedSha1;
                    }
                }
            } catch (e) { }
        }

        // verify checksum if available
        if (expectedSha1 || expectedSha256) {
            io.emit('console-output', `[INSTALL] Verifying checksum...`);
            const hashNames = [];
            if (expectedSha1) hashNames.push('sha1');
            if (expectedSha256) hashNames.push('sha256');

            const fileBuffer = fs.readFileSync(targetPath);
            if (expectedSha1) {
                const h = crypto.createHash('sha1').update(fileBuffer).digest('hex');
                if (h !== expectedSha1) {
                    io.emit('console-output', `[INSTALL] Checksum mismatch (sha1). Aborting.`);
                    try { fs.unlinkSync(targetPath); } catch (e) { }
                    throw new Error('Checksum mismatch');
                }
            }
            if (expectedSha256) {
                const h2 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
                if (h2 !== expectedSha256) {
                    io.emit('console-output', `[INSTALL] Checksum mismatch (sha256). Aborting.`);
                    try { fs.unlinkSync(targetPath); } catch (e) { }
                    throw new Error('Checksum mismatch');
                }
            }
            io.emit('console-output', `[INSTALL] Checksum OK (${hashNames.join(', ')})`);
        }

        io.emit('install-progress', 100);
        io.emit('console-output', `[INSTALL] Download complete. server.jar installed.`);
        io.emit('install-complete');
        // clear current download state
        currentDownload.controller = null;
        currentDownload.writer = null;
        currentDownload.promise = null;
        currentDownload.targetPath = null;
    } catch (err) {
        io.emit('console-output', `[INSTALL] Error downloading: ${err.message}`);
    }
}

function cancelDownload(io) {
    if (currentDownload && currentDownload.controller) {
        try {
            currentDownload.controller.abort();
        } catch (e) { }
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