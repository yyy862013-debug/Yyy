const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');

// Import the engine we built earlier
const { startServer, stopServer, sendCommand, downloadServerJar, deployServer } = require('./instance-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' } // OK for private use; restrict in production
});

// Parse URL-encoded bodies (login form)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());  // Also support JSON posts
app.use(cookieParser());  // Parse cookies

// Simple auth helper (cookie-based)
function isAuthenticated(req){
    // Check parsed cookies first (cookie-parser)
    if (req.cookies && req.cookies.panelAuth === '1') {
        return true;
    }
    // Fallback to manual cookie parsing (for direct header access)
    const c = req.headers.cookie || '';
    return c.split(';').some(s => s.trim() === 'panelAuth=1');
}

// Root and dashboard routing: force login phase first
app.get('/', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login.html');
    return res.redirect('/dashboard.html');
});

// Serve login.html without auth requirement (users need to be able to see it!)
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/public/login.html'));
});

// Auth middleware for all protected pages
const authMiddleware = (req, res, next) => {
    if (!isAuthenticated(req)) return res.redirect('/login.html');
    next();
};

// Serve protected HTML pages (dashboard, console, hub, etc.)
const protectedPages = ['dashboard.html', 'hub.html', 'console.html', 'files.html', 'backups.html', 'settings.html'];
protectedPages.forEach(page => {
    app.get(`/${page}`, authMiddleware, (req, res) => {
        res.sendFile(path.join(__dirname, '../frontend/public', page));
    });
});

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
        // Set cookies BEFORE redirect to ensure they're included
        res.cookie('panelAuth', '1', {
            path: '/',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            httpOnly: false,
            sameSite: 'Lax',
            secure: false  // for localhost, set to true in production with HTTPS
        });
        res.cookie('panelUsername', username, {
            path: '/',
            maxAge: 7 * 24 * 60 * 60 * 1000,
            httpOnly: false,
            sameSite: 'Lax',
            secure: false
        });
        
        // Redirect after cookies are set
        return res.status(302).redirect('/dashboard.html');
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
        const snapshot = req.query.snapshot === 'true';
        // Filter versions - snapshots OR releases depending on query param
        const ids = (r.data && r.data.versions) ? r.data.versions
            .filter(v => snapshot ? v.type === 'snapshot' : v.type === 'release')
            .map(v => v.id) : [];
        return res.json({ versions: ids });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// Forge versions endpoint
app.get('/api/forge-versions', async (req, res) => {
    try {
        // Fetch latest Forge promotions
        const r = await axios.get('https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json');
        const promos = r.data.promos || {};
        
        // Extract unique versions (e.g., "1.20.1-latest" -> "1.20.1")
        const versions = new Set();
        Object.keys(promos).forEach(key => {
            const parts = key.split('-');
            if (parts[0]) versions.add(parts[0]);
        });
        
        return res.json({ versions: Array.from(versions).sort().reverse().slice(0, 20) });
    } catch (e) {
        // Fallback to common versions
        return res.json({ versions: ['1.20.1', '1.20', '1.19.2', '1.18.2', '1.17.1'] });
    }
});

// Fabric versions endpoint
app.get('/api/fabric-versions', async (req, res) => {
    try {
        // Fetch Fabric loader versions
        const r = await axios.get('https://meta.fabricmc.net/v2/versions/game');
        const versions = r.data
            .filter(v => v.stable)
            .map(v => v.version)
            .slice(0, 20);
        
        return res.json({ versions });
    } catch (e) {
        // Fallback
        return res.json({ versions: ['1.20.1', '1.20', '1.19.2', '1.18.2'] });
    }
});

// CurseForge modpack info endpoint (given modpack ID)
app.get('/api/curseforge/modpack/:id', async (req, res) => {
    try {
        const modpackId = req.params.id;
        // CurseForge API requires key; for now, return basic structure
        // In production, you'd make actual API calls to CurseForge
        return res.json({ 
            modpackId,
            status: 'ready',
            message: `Modpack ${modpackId} queued for deployment` 
        });
    } catch (e) {
        return res.status(400).json({ error: e.message });
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

    // Handle deploy-server event (deploy any server type)
    socket.on('deploy-server', async (payload, callback) => {
        console.log(`[SOCKET] User requested deploy-server:`, payload);
        try {
            const { type, version } = payload;
            const im = require('./instance-manager');
            const result = await im.deployServer(type, version, io);
            callback({ success: true, message: 'Deployment started', result });
        } catch (err) {
            console.error('[SOCKET] Deploy error:', err);
            callback({ success: false, message: err.message });
        }
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