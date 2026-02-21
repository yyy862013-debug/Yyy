const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

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

module.exports = { startServer, sendCommand, stopServer };