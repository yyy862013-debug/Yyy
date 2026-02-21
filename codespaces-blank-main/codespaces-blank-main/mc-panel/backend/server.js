const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

// Import the engine we built earlier
const { startServer, stopServer, sendCommand, downloadServerJar } = require('./instance-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' } // OK for private use; restrict in production
});

// Parse URL-encoded bodies (login form)
app.use(express.urlencoded({ extended: true }));

// Simple auth helper (cookie-based)
function isAuthenticated(req){
    const c = req.headers.cookie || '';
    return c.split(';').map(s=>s.trim()).some(s=>s === 'panelAuth=1');
}

// Root and dashboard routing: force login phase first
app.get('/', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login.html');
    return res.redirect('/dashboard.html');
});

// Auth middleware for all protected pages
const authMiddleware = (req, res, next) => {
    if (!isAuthenticated(req)) return res.redirect('/login.html');
    next();
};

// Protect all page routes
app.get('/dashboard.html', authMiddleware, (req, res, next) => next());
app.get('/console.html', authMiddleware, (req, res, next) => next());
app.get('/files.html', authMiddleware, (req, res, next) => next());
app.get('/backups.html', authMiddleware, (req, res, next) => next());
app.get('/settings.html', authMiddleware, (req, res, next) => next());

// API routes for page data
app.get('/api/backups', authMiddleware, (req, res) => {
    // TODO: Implement actual backup file listing from backend/servers/
    return res.json({ backups: [] });
});

app.get('/api/settings', authMiddleware, (req, res) => {
    try {
        const im = require('./instance-manager');
        const settings = im.readSettings ? im.readSettings() : {};
        return res.json(settings);
    } catch (e) {
        return res.json({ error: e.message });
    }
});

app.get('/api/server-status', authMiddleware, (req, res) => {
    // TODO: Get actual server status from instance manager
    return res.json({ 
        status: 'offline', 
        players: '0/20', 
        uptime: 0,
        ram: '0GB / 4GB'
    });
});

// Login endpoint - simple hardcoded credentials for private use
app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === 'admin' && password === 'password') {
        // set a simple cookie (not secure; fine for private local use)
        res.setHeader('Set-Cookie', 'panelAuth=1; Path=/');
        return res.redirect('/dashboard.html');
    }
    return res.status(401).send('Invalid credentials');
});

// Logout clears cookie
app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'panelAuth=; Path=/; Max-Age=0');
    return res.redirect('/login.html');
});

// Tell Express to serve our Frontend files
app.use(express.static(path.join(__dirname, '../frontend/public')));

// --- API proxy endpoints for dynamic version lists ---
app.get('/api/paper-versions', async (req, res) => {
    try {
        const r = await axios.get('https://api.papermc.io/v2/projects/paper');
        return res.json({ versions: r.data.versions || [] });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/paper-builds/:version', async (req, res) => {
    const v = req.params.version;
    try {
        const r = await axios.get(`https://api.papermc.io/v2/projects/paper/versions/${v}/builds`);
        return res.json(r.data);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.get('/api/vanilla-versions', async (req, res) => {
    try {
        const r = await axios.get('https://launchermeta.mojang.com/mc/game/version_manifest.json');
        // return only release versions (exclude snapshots) to avoid entries without server jar
        const ids = (r.data && r.data.versions) ? r.data.versions.filter(v => v.type === 'release').map(v => v.id) : [];
        return res.json({ versions: ids });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

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
        // Save selected version to settings
        try {
            const settings = require('./instance-manager')._readSettings ? require('./instance-manager')._readSettings() : null;
        } catch (e) { }
        // call installer
        downloadServerJar(versionTag, io);
    });

    // Cancel ongoing install
    socket.on('cancel-install', () => {
        console.log('[SOCKET] User requested cancel-install');
        try { require('./instance-manager').cancelDownload(io); } catch (e) { }
    });

    // Save selected version server-side
    socket.on('save-selected-version', (versionTag) => {
        try {
            const im = require('./instance-manager');
            const s = im.readSettings ? im.readSettings() : null;
            const settings = s || {};
            settings.selectedVersion = versionTag;
            im.writeSettings ? im.writeSettings(settings) : null;
            io.emit('console-output', `[PANEL] Selected version saved: ${versionTag}`);
        } catch (e) { io.emit('console-output', `[PANEL] Failed to save selected version: ${e.message}`); }
    });

    // Provide selected version to client
    socket.on('get-selected-version', () => {
        try {
            const im = require('./instance-manager');
            const s = im.readSettings ? im.readSettings() : {};
            socket.emit('selected-version', s.selectedVersion || null);
        } catch (e) { socket.emit('selected-version', null); }
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