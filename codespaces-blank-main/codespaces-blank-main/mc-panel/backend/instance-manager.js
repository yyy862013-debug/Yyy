const { spawn } = require('child_process');
const path = require('path');

// This function starts the Minecraft server
function startServer(io) {
    // 1. Tell Node where the server.jar is located
    const serverPath = path.join(__dirname, 'servers', 'survival-world');

    // 2. Start the Java process (The "Spawn")
    const minecraftServer = spawn('java', [
        '-Xmx2G', 
        '-Xms1G', 
        '-jar', 'server.jar', 
        'nogui'
    ], { cwd: serverPath });

    // 3. Listen for text coming FROM the Minecraft server
    minecraftServer.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(`[MC]: ${output}`); // Print to your VS Code terminal
        
        // 4. Send that text to your Website via WebSockets
        io.emit('console-output', output);
    });

    // 5. Catch errors (like Java not being installed)
    minecraftServer.on('error', (err) => {
        io.emit('console-output', `Failed to start server: ${err.message}`);
    });

    return minecraftServer;
}

module.exports = { startServer };