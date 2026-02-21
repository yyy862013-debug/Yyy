const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

let minecraftProcess = null;

function startServer(io) {
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
        io.emit('console-output', '[PANEL] Error: server.jar missing. Select a version and Install first.');
        io.emit('require-install');
        return;
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

    if (project !== 'paper') {
        io.emit('console-output', `[INSTALL] Installer currently supports Paper via PaperMC API only (received: ${versionTag}).`);
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

        const resp = await axios.get(fileUrl, { responseType: 'stream' });
        const total = resp.headers['content-length'] ? parseInt(resp.headers['content-length'], 10) : null;

        const writer = fs.createWriteStream(targetPath);
        let received = 0;
        resp.data.on('data', (chunk) => {
            received += chunk.length;
            if (total) {
                const pct = Math.floor((received / total) * 100);
                io.emit('console-output', `[INSTALL] Downloaded ${pct}%`);
            }
        });

        resp.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            resp.data.on('error', reject);
        });

        io.emit('console-output', `[INSTALL] Download complete. server.jar installed.`);
    } catch (err) {
        io.emit('console-output', `[INSTALL] Error downloading: ${err.message}`);
    }
}

module.exports = { startServer, sendCommand, stopServer, downloadServerJar };