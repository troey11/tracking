// WebSocket Location Tracking Server
// Node.js backend untuk menerima dan menyebarkan data lokasi realtime

const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

class LocationTrackingServer {
    constructor(port = 8080, httpPort = 3000) {
        this.wsPort = port;
        this.httpPort = httpPort;
        this.connectedDevices = new Map();
        this.locationHistory = new Map();
        this.webClients = new Set();
        this.startTime = new Date();
        
        this.initExpressServer();
        this.initWebSocketServer();
        this.startPeriodicTasks();
        
        console.log(`?? Location Tracking Server initialized`);
        console.log(`?? WebSocket Server: ws://localhost:${this.wsPort}`);
        console.log(`?? HTTP Server: http://localhost:${this.httpPort}`);
    }

    initExpressServer() {
        this.app = express();
        this.server = http.createServer(this.app);

        // Middleware
        this.app.use(cors());
        this.app.use(express.json());
        this.app.use(express.static('public'));

        // API Routes
        this.setupRoutes();

        // Start HTTP server
        this.server.listen(this.httpPort, () => {
            console.log(`? HTTP Server running on port ${this.httpPort}`);
        });
    }

    setupRoutes() {
        // Get all connected devices
        this.app.get('/api/devices', (req, res) => {
            const devices = Array.from(this.connectedDevices.values()).map(device => ({
                ...device,
                isOnline: this.isDeviceOnline(device)
            }));
            
            res.json({
                success: true,
                data: devices,
                count: devices.length
            });
        });

        // Get specific device info
        this.app.get('/api/devices/:deviceId', (req, res) => {
            const deviceId = req.params.deviceId;
            const device = this.connectedDevices.get(deviceId);
            
            if (!device) {
                return res.status(404).json({
                    success: false,
                    message: 'Device not found'
                });
            }

            res.json({
                success: true,
                data: {
                    ...device,
                    isOnline: this.isDeviceOnline(device),
                    locationHistory: this.locationHistory.get(deviceId) || []
                }
            });
        });

        // Get location history for a device
        this.app.get('/api/devices/:deviceId/history', (req, res) => {
            const deviceId = req.params.deviceId;
            const limit = parseInt(req.query.limit) || 100;
            const startDate = req.query.startDate;
            const endDate = req.query.endDate;

            let history = this.locationHistory.get(deviceId) || [];

            // Filter by date range if provided
            if (startDate || endDate) {
                history = history.filter(location => {
                    const locationTime = new Date(location.timestamp);
                    if (startDate && locationTime < new Date(startDate)) return false;
                    if (endDate && locationTime > new Date(endDate)) return false;
                    return true;
                });
            }

            // Apply limit
            history = history.slice(-limit);

            res.json({
                success: true,
                data: history,
                count: history.length
            });
        });

        // Get server statistics
        this.app.get('/api/stats', (req, res) => {
            const stats = this.getServerStats();
            res.json({
                success: true,
                data: stats
            });
        });

        // Export location data
        this.app.get('/api/export/:format', (req, res) => {
            const format = req.params.format; // json, csv, gpx
            const deviceId = req.query.deviceId;
            
            try {
                const exportData = this.exportLocationData(format, deviceId);
                
                const filename = `location-export-${new Date().toISOString().slice(0, 10)}.${format}`;
                
                switch (format) {
                    case 'json':
                        res.setHeader('Content-Type', 'application/json');
                        break;
                    case 'csv':
                        res.setHeader('Content-Type', 'text/csv');
                        break;
                    case 'gpx':
                        res.setHeader('Content-Type', 'application/gpx+xml');
                        break;
                }
                
                res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
                res.send(exportData);
                
            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: 'Export failed: ' + error.message
                });
            }
        });

        // Send command to specific device
        this.app.post('/api/devices/:deviceId/command', (req, res) => {
            const deviceId = req.params.deviceId;
            const command = req.body;

            const device = this.connectedDevices.get(deviceId);
            if (!device) {
                return res.status(404).json({
                    success: false,
                    message: 'Device not found'
                });
            }

            if (!device.websocket || device.websocket.readyState !== WebSocket.OPEN) {
                return res.status(400).json({
                    success: false,
                    message: 'Device is not connected'
                });
            }

            try {
                device.websocket.send(JSON.stringify({
                    type: 'command',
                    ...command,
                    timestamp: new Date().toISOString()
                }));

                res.json({
                    success: true,
                    message: 'Command sent successfully'
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: 'Failed to send command: ' + error.message
                });
            }
        });

        // Serve the monitoring dashboard
        this.app.get('/dashboard', (req, res) => {
            res.sendFile(path.join(__dirname, 'dashboard.html'));
        });

        // Serve the mobile app
        this.app.get('/mobile', (req, res) => {
            res.sendFile(path.join(__dirname, 'mobile.html'));
        });
    }

    initWebSocketServer() {
        this.wss = new WebSocket.Server({ 
            port: this.wsPort,
            perMessageDeflate: false
        });

        this.wss.on('connection', (ws, req) => {
            const clientIP = req.socket.remoteAddress;
            const userAgent = req.headers['user-agent'];
            
            console.log(`?? New connection from ${clientIP}`);
            console.log(`?? User Agent: ${userAgent}`);

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleWebSocketMessage(ws, message, clientIP);
                } catch (error) {
                    console.error('? Invalid JSON message:', error);
                    this.sendError(ws, 'Invalid JSON format');
                }
            });

            ws.on('close', (code, reason) => {
                console.log(`?? Connection closed: ${code} - ${reason}`);
                this.handleDeviceDisconnection(ws);
            });

            ws.on('error', (error) => {
                console.error('? WebSocket error:', error);
            });

            // Send welcome message
            this.sendMessage(ws, {
                type: 'welcome',
                message: 'Connected to Location Tracking Server',
                serverTime: new Date().toISOString()
            });
        });

        console.log(`? WebSocket Server running on port ${this.wsPort}`);
    }

    handleWebSocketMessage(ws, message, clientIP) {
        console.log(`?? Received message type: ${message.type}`);

        switch (message.type) {
            case 'device_info':
                this.handleDeviceRegistration(ws, message, clientIP);
                break;

            case 'location_update':
                this.handleLocationUpdate(ws, message);
                break;

            case 'web_client_connect':
                this.handleWebClientConnection(ws);
                break;

            case 'ping':
                this.sendMessage(ws, { 
                    type: 'pong', 
                    timestamp: new Date().toISOString() 
                });
                break;

            case 'stop_tracking':
                this.handleStopTracking(ws);
                break;

            default:
                console.log(`?? Unknown message type: ${message.type}`);
        }
    }

    handleDeviceRegistration(ws, message, clientIP) {
        const deviceId = this.generateDeviceId(message.deviceName, clientIP);
        
        const deviceInfo = {
            deviceId: deviceId,
            deviceName: message.deviceName || 'Unknown Device',
            userAgent: message.userAgent || 'Unknown',
            clientIP: clientIP,
            connectedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            websocket: ws,
            location: null,
            batteryLevel: null,
            settings: {}
        };

        this.connectedDevices.set(deviceId, deviceInfo);
        ws.deviceId = deviceId;

        // Initialize location history if not exists
        if (!this.locationHistory.has(deviceId)) {
            this.locationHistory.set(deviceId, []);
        }

        console.log(`? Device registered: ${deviceInfo.deviceName} (${deviceId})`);

        // Send device ID back to client
        this.sendMessage(ws, {
            type: 'device_registered',
            deviceId: deviceId,
            message: 'Device registered successfully'
        });

        // Broadcast to web clients
        this.broadcastToWebClients({
            type: 'device_connected',
            device: this.sanitizeDeviceInfo(deviceInfo)
        });

        this.saveDeviceToFile(deviceInfo);
    }

    handleLocationUpdate(ws, message) {
        const deviceId = ws.deviceId;
        if (!deviceId) {
            this.sendError(ws, 'Device not registered');
            return;
        }

        const device = this.connectedDevices.get(deviceId);
        if (!device) {
            this.sendError(ws, 'Device not found');
            return;
        }

        // Update device info
        device.lastSeen = new Date().toISOString();
        device.location = {
            latitude: message.latitude,
            longitude: message.longitude,
            accuracy: message.accuracy,
            altitude: message.altitude,
            altitudeAccuracy: message.altitudeAccuracy,
            heading: message.heading,
            speed: message.speed,
            timestamp: message.timestamp
        };

        // Add to location history
        const history = this.locationHistory.get(deviceId);
        history.push(device.location);

        // Keep only last 1000 locations per device
        if (history.length > 1000) {
            history.shift();
        }

        console.log(`?? Location update from ${device.deviceName}: ${message.latitude.toFixed(6)}, ${message.longitude.toFixed(6)}`);

        // Send acknowledgment
        this.sendMessage(ws, {
            type: 'location_ack',
            timestamp: new Date().toISOString()
        });

        // Broadcast to web clients
        this.broadcastToWebClients({
            type: 'location_update',
            deviceId: deviceId,
            location: device.location,
            deviceName: device.deviceName
        });

        // Check for geofence alerts
        this.checkGeofences(device);

        // Save to file periodically
        this.saveLocationToFile(deviceId, device.location);
    }

    handleWebClientConnection(ws) {
        this.webClients.add(ws);
        console.log(`?? Web client connected. Total: ${this.webClients.size}`);

        // Send current device list to new web client
        const devices = Array.from(this.connectedDevices.values()).map(device => 
            this.sanitizeDeviceInfo(device)
        );

        this.sendMessage(ws, {
            type: 'initial_data',
            devices: devices,
            stats: this.getServerStats()
        });

        ws.on('close', () => {
            this.webClients.delete(ws);
            console.log(`?? Web client disconnected. Total: ${this.webClients.size}`);
        });
    }

    handleDeviceDisconnection(ws) {
        if (ws.deviceId) {
            const device = this.connectedDevices.get(ws.deviceId);
            if (device) {
                console.log(`?? Device disconnected: ${device.deviceName}`);
                
                // Keep device info but mark as disconnected
                device.websocket = null;
                device.disconnectedAt = new Date().toISOString();

                // Broadcast to web clients
                this.broadcastToWebClients({
                    type: 'device_disconnected',
                    deviceId: ws.deviceId
                });
            }
        } else if (this.webClients.has(ws)) {
            this.webClients.delete(ws);
        }
    }

    handleStopTracking(ws) {
        const deviceId = ws.deviceId;
        if (deviceId) {
            const device = this.connectedDevices.get(deviceId);
            if (device) {
                console.log(`?? Tracking stopped for ${device.deviceName}`);
                
                this.broadcastToWebClients({
                    type: 'tracking_stopped',
                    deviceId: deviceId
                });
            }
        }
    }

    generateDeviceId(deviceName, clientIP) {
        const timestamp = Date.now();
        const hash = require('crypto')
            .createHash('md5')
            .update(deviceName + clientIP + timestamp)
            .digest('hex')
            .substring(0, 8);
        
        return `${deviceName.replace(/\s+/g, '-')}-${hash}`;
    }

    sanitizeDeviceInfo(device) {
        return {
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            connectedAt: device.connectedAt,
            lastSeen: device.lastSeen,
            location: device.location,
            batteryLevel: device.batteryLevel,
            isOnline: this.isDeviceOnline(device)
        };
    }

    isDeviceOnline(device) {
        if (!device.lastSeen) return false;
        const lastSeen = new Date(device.lastSeen);
        const now = new Date();
        const diffMinutes = (now - lastSeen) / (1000 * 60);
        return diffMinutes < 5 && device.websocket && device.websocket.readyState === WebSocket.OPEN;
    }

    broadcastToWebClients(message) {
        const messageStr = JSON.stringify(message);
        
        this.webClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(messageStr);
                } catch (error) {
                    console.error('Failed to send to web client:', error);
                    this.webClients.delete(client);
                }
            }
        });
    }

    sendMessage(ws, message) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(message));
            } catch (error) {
                console.error('Failed to send message:', error);
            }
        }
    }

    sendError(ws, errorMessage) {
        this.sendMessage(ws, {
            type: 'error',
            message: errorMessage,
            timestamp: new Date().toISOString()
        });
    }

    checkGeofences(device) {
        // Example geofence check - customize based on your needs
        const geofences = [
            {
                name: 'Office Area',
                center: { lat: -6.2088, lng: 106.8456 },
                radius: 1000, // meters
                alertOnExit: true,
                alertOnEntry: false
            },
            {
                name: 'Restricted Zone',
                center: { lat: -6.1751, lng: 106.8650 },
                radius: 500,
                alertOnEntry: true,
                alertOnExit: false
            }
        ];

        geofences.forEach(fence => {
            const distance = this.calculateDistance(
                device.location.latitude,
                device.location.longitude,
                fence.center.lat,
                fence.center.lng
            );

            const isInside = distance <= fence.radius;
            const wasInside = device.lastGeofenceStatus && device.lastGeofenceStatus[fence.name];

            if (isInside && !wasInside && fence.alertOnEntry) {
                this.sendGeofenceAlert(device, fence, 'ENTERED');
            } else if (!isInside && wasInside && fence.alertOnExit) {
                this.sendGeofenceAlert(device, fence, 'EXITED');
            }

            // Update geofence status
            if (!device.lastGeofenceStatus) {
                device.lastGeofenceStatus = {};
            }
            device.lastGeofenceStatus[fence.name] = isInside;
        });
    }

    sendGeofenceAlert(device, fence, action) {
        const alert = {
            type: 'geofence_alert',
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            geofenceName: fence.name,
            action: action,
            timestamp: new Date().toISOString(),
            location: device.location
        };

        console.log(`?? Geofence Alert: ${device.deviceName} ${action} ${fence.name}`);

        // Broadcast to web clients
        this.broadcastToWebClients(alert);

        // Log to file
        this.logAlert(alert);
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // Earth's radius in meters
        const f1 = lat1 * Math.PI/180;
        const f2 = lat2 * Math.PI/180;
        const ?f = (lat2-lat1) * Math.PI/180;
        const ?? = (lon2-lon1) * Math.PI/180;

        const a = Math.sin(?f/2) * Math.sin(?f/2) +
                  Math.cos(f1) * Math.cos(f2) *
                  Math.sin(??/2) * Math.sin(??/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

        return R * c; // Distance in meters
    }

    getServerStats() {
        const uptime = new Date() - this.startTime;
        const totalLocations = Array.from(this.locationHistory.values())
            .reduce((sum, history) => sum + history.length, 0);

        return {
            uptime: uptime,
            uptimeFormatted: this.formatUptime(uptime),
            totalDevices: this.connectedDevices.size,
            onlineDevices: Array.from(this.connectedDevices.values())
                .filter(device => this.isDeviceOnline(device)).length,
            totalLocationUpdates: totalLocations,
            webClients: this.webClients.size,
            memoryUsage: process.memoryUsage(),
            serverTime: new Date().toISOString()
        };
    }

    formatUptime(uptime) {
        const seconds = Math.floor(uptime / 1000);
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainingSeconds = seconds % 60;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    exportLocationData(format, deviceId = null) {
        let data = {};
        
        if (deviceId) {
            const device = this.connectedDevices.get(deviceId);
            const history = this.locationHistory.get(deviceId);
            
            if (!device || !history) {
                throw new Error('Device not found or no location history');
            }
            
            data[deviceId] = {
                device: this.sanitizeDeviceInfo(device),
                locations: history
            };
        } else {
            // Export all devices
            this.connectedDevices.forEach((device, id) => {
                data[id] = {
                    device: this.sanitizeDeviceInfo(device),
                    locations: this.locationHistory.get(id) || []
                };
            });
        }

        switch (format) {
            case 'json':
                return JSON.stringify(data, null, 2);

            case 'csv':
                return this.convertToCSV(data);

            case 'gpx':
                return this.convertToGPX(data);

            default:
                throw new Error('Unsupported export format');
        }
    }

    convertToCSV(data) {
        let csv = 'DeviceID,DeviceName,Timestamp,Latitude,Longitude,Accuracy,Speed,Heading\n';
        
        Object.entries(data).forEach(([deviceId, deviceData]) => {
            deviceData.locations.forEach(location => {
                csv += `${deviceId},${deviceData.device.deviceName},${location.timestamp},${location.latitude},${location.longitude},${location.accuracy || ''},${location.speed || ''},${location.heading || ''}\n`;
            });
        });

        return csv;
    }

    convertToGPX(data) {
        let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Location Tracking Server">
<metadata>
    <name>Location Tracking Export</name>
    <time>${new Date().toISOString()}</time>
</metadata>\n`;

        Object.entries(data).forEach(([deviceId, deviceData]) => {
            if (deviceData.locations.length === 0) return;

            gpx += `<trk>
    <name>${deviceData.device.deviceName}</name>
    <trkseg>\n`;

            deviceData.locations.forEach(location => {
                gpx += `        <trkpt lat="${location.latitude}" lon="${location.longitude}">
            <time>${location.timestamp}</time>`;
                
                if (location.altitude) {
                    gpx += `<ele>${location.altitude}</ele>`;
                }
                
                gpx += `</trkpt>\n`;
            });

            gpx += `    </trkseg>
</trk>\n`;
        });

        gpx += '</gpx>';
        return gpx;
    }

    startPeriodicTasks() {
        // Cleanup disconnected devices periodically
        setInterval(() => {
            this.cleanupDisconnectedDevices();
        }, 5 * 60 * 1000); // Every 5 minutes

        // Send ping to all connected devices
        setInterval(() => {
            this.pingAllDevices();
        }, 30 * 1000); // Every 30 seconds

        // Save statistics periodically
        setInterval(() => {
            this.saveStatsToFile();
        }, 10 * 60 * 1000); // Every 10 minutes

        console.log('? Periodic tasks started');
    }

    cleanupDisconnectedDevices() {
        const now = new Date();
        const maxOfflineTime = 30 * 60 * 1000; // 30 minutes

        this.connectedDevices.forEach((device, deviceId) => {
            if (!this.isDeviceOnline(device)) {
                const lastSeen = new Date(device.lastSeen);
                if (now - lastSeen > maxOfflineTime) {
                    console.log(`??? Removing inactive device: ${device.deviceName}`);
                    this.connectedDevices.delete(deviceId);
                    
                    // Optionally keep location history or remove it too
                    // this.locationHistory.delete(deviceId);
                }
            }
        });
    }

    pingAllDevices() {
        this.connectedDevices.forEach((device) => {
            if (device.websocket && device.websocket.readyState === WebSocket.OPEN) {
                this.sendMessage(device.websocket, {
                    type: 'ping',
                    timestamp: new Date().toISOString()
                });
            }
        });
    }

    saveDeviceToFile(deviceInfo) {
        const logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        const logEntry = {
            timestamp: new Date().toISOString(),
            action: 'device_connected',
            deviceId: deviceInfo.deviceId,
            deviceName: deviceInfo.deviceName,
            clientIP: deviceInfo.clientIP,
            userAgent: deviceInfo.userAgent
        };

        fs.appendFileSync(
            path.join(logDir, 'device-connections.log'), 
            JSON.stringify(logEntry) + '\n'
        );
    }

    saveLocationToFile(deviceId, location) {
        const logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        const today = new Date().toISOString().slice(0, 10);
        const filename = `locations-${today}.log`;

        const logEntry = {
            timestamp: new Date().toISOString(),
            deviceId: deviceId,
            location: location
        };

        fs.appendFileSync(
            path.join(logDir, filename), 
            JSON.stringify(logEntry) + '\n'
        );
    }

    logAlert(alert) {
        const logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        fs.appendFileSync(
            path.join(logDir, 'alerts.log'), 
            JSON.stringify(alert) + '\n'
        );
    }

    saveStatsToFile() {
        const stats = this.getServerStats();
        const logDir = './logs';
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        const statsEntry = {
            timestamp: new Date().toISOString(),
            ...stats
        };

        fs.appendFileSync(
            path.join(logDir, 'server-stats.log'), 
            JSON.stringify(statsEntry) + '\n'
        );
    }

    // Graceful shutdown
    shutdown() {
        console.log('?? Shutting down server...');

        // Close WebSocket server
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.close(1000, 'Server shutdown');
            }
        });
        this.wss.close();

        // Close HTTP server
        this.server.close();

        // Clear intervals
        clearInterval(this.cleanupInterval);
        clearInterval(this.pingInterval);
        clearInterval(this.statsInterval);

        console.log('? Server shutdown complete');
        process.exit(0);
    }
}

// Initialize server
const server = new LocationTrackingServer(8080, 3000);

// Handle graceful shutdown
process.on('SIGINT', () => {
    server.shutdown();
});

process.on('SIGTERM', () => {
    server.shutdown();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('? Uncaught Exception:', error);
    server.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('? Unhandled Rejection at:', promise, 'reason:', reason);
    server.shutdown();
});

module.exports = LocationTrackingServer;