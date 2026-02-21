const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// Import the engine we built earlier
// (Make sure you have your instance-manager.js in the same folder!)
const { startServer } = require('./instance-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Tell Express to serve our Frontend files
app.use(express.static(path.join(__dirname, '../frontend/public')));

// Listen for users connecting to the website
io.on('connection', (socket) => {
    console.log('A user connected to the dashboard!');

    // When you click the "Start" button on the website...
    socket.on('start-server', () => {
        io.emit('console-output', '[PANEL] Starting Minecraft Server...');
        startServer(io); 
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