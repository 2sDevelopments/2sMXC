// 2sMXC, project made by the 2sDevelopments
// Free for every one to use
// make it for server reasons

const net = require('net');
const fs = require('fs');
const dns = require('dns');
const WebSocket = require('ws');
const express = require('express');
const path = require('path');

// Load Config
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
    console.error("config.json not found!");
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

if (!fs.existsSync(path.join(__dirname, 'logs'))) fs.mkdirSync(path.join(__dirname, 'logs'));

function log(prefix, msg) {
    const line = `[${new Date().toISOString()}] [${prefix}] ${msg}`;
    if (config.logging.console) console.log(line);
    if (config.logging.file) {
        fs.appendFileSync(path.join(__dirname, 'logs', 'agent.log'), line + '\n');
    }
}

const dashboardState = {
    agentName: config.agentName,
    resolvedIP: null,
    tunnels: []
};

function resolvePlayitIP(hostname) {
    return new Promise((resolve, reject) => {
        dns.lookup(hostname, (err, address) => {
            if (err) reject(err);
            else resolve(address);
        });
    });
}

function startHeartbeat(socket, name) {
    const interval = setInterval(() => {
        if (socket.destroyed) clearInterval(interval);
        else socket.write(Buffer.from([0x00]));
    }, config.network.heartbeatInterval);
    log(name, "Heartbeat started");
}

// Tunnel Connection
function connectTunnel(type, ip, port, localHost, localPort, options = {}) {
    const tunnelName = `${type.toUpperCase()} [Port: ${port}]`;
    dashboardState.tunnels.push({ type, port, localHost, localPort, status: 'Connecting' });

    if (options.useWSS) {
        const protocol = options.tls ? 'wss' : 'ws';
        const url = `${protocol}://${ip}:${port}`;
        const ws = new WebSocket(url);

        ws.on('open', () => {
            log(tunnelName, `Connected to ${url}`);
            dashboardState.tunnels.find(t => t.port === port).status = 'Connected';
            startHeartbeat(ws, tunnelName);

            const local = net.connect(localPort, localHost);
            ws.on('message', msg => local.write(msg));
            local.on('data', data => ws.send(data));
        });

        ws.on('close', () => {
            log(tunnelName, "Closed. Reconnecting...");
            dashboardState.tunnels.find(t => t.port === port).status = 'Reconnecting';
            setTimeout(() => connectTunnel(type, ip, port, localHost, localPort, options), config.network.reconnectDelay);
        });

        ws.on('error', err => {
            log(tunnelName, `Error: ${err.message}`);
            ws.terminate();
            dashboardState.tunnels.find(t => t.port === port).status = 'Error';
            setTimeout(() => connectTunnel(type, ip, port, localHost, localPort, options), config.network.reconnectDelay);
        });

    } else {
        const socket = net.connect(port, ip, () => {
            log(tunnelName, `Connected`);
            dashboardState.tunnels.find(t => t.port === port).status = 'Connected';
            startHeartbeat(socket, tunnelName);

            const local = net.connect(localPort, localHost);
            socket.pipe(local);
            local.pipe(socket);
        });

        socket.on('close', () => {
            log(tunnelName, "Closed. Reconnecting...");
            dashboardState.tunnels.find(t => t.port === port).status = 'Reconnecting';
            setTimeout(() => connectTunnel(type, ip, port, localHost, localPort, options), config.network.reconnectDelay);
        });

        socket.on('error', err => {
            log(tunnelName, `Error: ${err.message}`);
            socket.destroy();
            dashboardState.tunnels.find(t => t.port === port).status = 'Error';
            setTimeout(() => connectTunnel(type, ip, port, localHost, localPort, options), config.network.reconnectDelay);
        });
    }
}

// Starting the Agent here
async function startAgent() {
    log(config.agentName, "Agent starting...");

    try {
        const playitIP = await resolvePlayitIP(config.playit.ip);
        dashboardState.resolvedIP = playitIP;
        log(config.agentName, `Resolved Playit IP: ${playitIP}`);

        config.servers.forEach((server, index) => {
            if (!server.enabled) return;

            const port = config.playit.basePort + index;
            log(config.agentName, `Starting ${server.type} tunnel on port ${port} → ${server.localHost}:${server.localPort}`);

            connectTunnel(
                server.type,
                playitIP,
                port,
                server.localHost,
                server.localPort,
                { useWSS: server.useWSS || false, tls: server.tls || false }
            );
        });

    } catch (err) {
        log(config.agentName, `Failed to resolve Playit IP: ${err.message}`);
        setTimeout(startAgent, config.network.reconnectDelay);
    }
}

const app = express();
const HTTP_PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const wss = new WebSocket.Server({ port: 3001 });
wss.on('connection', ws => {
    ws.send(JSON.stringify(dashboardState));
    const interval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(dashboardState));
    }, 1000);
});

app.listen(HTTP_PORT, () => log('Dashboard', `HTTP dashboard running on http://localhost:${HTTP_PORT}`));

startAgent();
