const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Import the engine we built earlier
const { startServer, stopServer, sendCommand, downloadServerJar } = require('./instance-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' } // OK for private use; restrict in production
});

// Tell Express to serve our Frontend files
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Listen for users connecting to the website
io.on('connection', (socket) => {
    console.log('A user connected to the dashboard!');

    // When you click the "Start" button on the website...
    socket.on('start-server', () => {
        console.log(`[SOCKET] User requested server start`);
        startServer(io); 
    });

    // Handle stop-server event
    socket.on('stop-server', () => {
        console.log(`[SOCKET] User requested server stop`);
        stopServer();
    });

    // Handle send-command event
    socket.on('send-command', (command) => {
        console.log(`[SOCKET] User sent command: ${command}`);
        sendCommand(command);
    });

    // Handle install-version event (download server.jar)
    socket.on('install-version', (versionTag) => {
        console.log(`[SOCKET] User requested install-version: ${versionTag}`);
        // Pass the io instance so installer can emit progress messages
        downloadServerJar(versionTag, io);
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected.');
    });
});

// Start the web server on port 3000
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Panel running! Open http://localhost:${PORT} in your browser.`);
});

// Graceful shutdown on process signals
process.on('SIGTERM', () => {
    console.log('[PANEL] SIGTERM received, shutting down...');
    server.close(() => {
        console.log('[PANEL] Server closed.');
        process.exit(0);
    });
});