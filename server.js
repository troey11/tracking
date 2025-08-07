// WebSocket Location Tracking Server
// Node.js backend untuk menerima dan menyebarkan data lokasi realtime
// Compatible with Node.js 10+

const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

class LocationTrackingServer {
    constructor(port, httpPort) {
        this.wsPort = port || 8080;
        this.httpPort = httpPort || 4000;
        this.connectedDevices = new Map();
        this.locationHistory = new Map();
        this.webClients = new Set();
        this.startTime = new Date();
        
        this.initExpressServer();
        this.initWebSocketServer();
        this.startPeriodicTasks();
        
        console.log('📡 Location Tracking Server initialized');
        console.log('🔌 WebSocket Server: ws://localhost:' + this.wsPort);
        console.log('🌐 HTTP Server: http://localhost:' + this.httpPort);
        console.log('📊 Dashboard: http://localhost:' + this.httpPort + '/dashboard');
        console.log('📱 Mobile App: http://localhost:' + this.httpPort + '/mobile');
        console.log('================================');
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
        var self = this;
        this.server.listen(this.httpPort, function() {
            console.log('✅ HTTP Server running on port ' + self.httpPort);
        });
    }

    setupRoutes() {
        var self = this;

        // Get all connected devices
        this.app.get('/api/devices', function(req, res) {
            var devices = Array.from(self.connectedDevices.values()).map(function(device) {
                var deviceCopy = Object.assign({}, device);
                deviceCopy.isOnline = self.isDeviceOnline(device);
                return deviceCopy;
            });
            
            res.json({
                success: true,
                data: devices,
                count: devices.length
            });
        });

        // Get specific device info
        this.app.get('/api/devices/:deviceId', function(req, res) {
            var deviceId = req.params.deviceId;
            var device = self.connectedDevices.get(deviceId);
            
            if (!device) {
                return res.status(404).json({
                    success: false,
                    message: 'Device not found'
                });
            }

            var deviceInfo = Object.assign({}, device);
            deviceInfo.isOnline = self.isDeviceOnline(device);
            deviceInfo.locationHistory = self.locationHistory.get(deviceId) || [];

            res.json({
                success: true,
                data: deviceInfo
            });
        });

        // Get location history for a device
        this.app.get('/api/devices/:deviceId/history', function(req, res) {
            var deviceId = req.params.deviceId;
            var limit = parseInt(req.query.limit) || 100;
            var startDate = req.query.startDate;
            var endDate = req.query.endDate;

            var history = self.locationHistory.get(deviceId) || [];

            // Filter by date range if provided
            if (startDate || endDate) {
                history = history.filter(function(location) {
                    var locationTime = new Date(location.timestamp);
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
        this.app.get('/api/stats', function(req, res) {
            var stats = self.getServerStats();
            res.json({
                success: true,
                data: stats
            });
        });

        // Export location data
        this.app.get('/api/export/:format', function(req, res) {
            var format = req.params.format; // json, csv, gpx
            var deviceId = req.query.deviceId;
            
            try {
                var exportData = self.exportLocationData(format, deviceId);
                
                var filename = 'location-export-' + new Date().toISOString().slice(0, 10) + '.' + format;
                
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
                
                res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
                res.send(exportData);
                
            } catch (error) {
                res.status(500).json({
                    success: false,
                    message: 'Export failed: ' + error.message
                });
            }
        });

        // Send command to specific device
        this.app.post('/api/devices/:deviceId/command', function(req, res) {
            var deviceId = req.params.deviceId;
            var command = req.body;

            var device = self.connectedDevices.get(deviceId);
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
                var commandMessage = Object.assign({}, command);
                commandMessage.type = 'command';
                commandMessage.timestamp = new Date().toISOString();
                
                device.websocket.send(JSON.stringify(commandMessage));

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
        this.app.get('/dashboard', function(req, res) {
            res.sendFile(path.join(__dirname, 'dashboard.html'));
        });

        // Serve the mobile app
        this.app.get('/mobile', function(req, res) {
            res.sendFile(path.join(__dirname, 'mobile.html'));
        });
    }

    initWebSocketServer() {
        var self = this;
        this.wss = new WebSocket.Server({
    port: this.wsPort,
    host: '0.0.0.0',
    perMessageDeflate: false
});

        this.wss.on('connection', function(ws, req) {
            var clientIP = req.socket.remoteAddress;
            var userAgent = req.headers['user-agent'];
            
            console.log('🔗 New connection from ' + clientIP);
            console.log('📱 User Agent: ' + userAgent);

            ws.on('message', function(data) {
                try {
                    var message = JSON.parse(data.toString());
                    self.handleWebSocketMessage(ws, message, clientIP);
                } catch (error) {
                    console.error('❌ Invalid JSON message:', error);
                    self.sendError(ws, 'Invalid JSON format');
                }
            });

            ws.on('close', function(code, reason) {
                console.log('🔌 Connection closed: ' + code + ' - ' + reason);
                self.handleDeviceDisconnection(ws);
            });

            ws.on('error', function(error) {
                console.error('❌ WebSocket error:', error);
            });

            // Send welcome message
            self.sendMessage(ws, {
                type: 'welcome',
                message: 'Connected to Location Tracking Server',
                serverTime: new Date().toISOString()
            });
        });

        console.log('✅ WebSocket Server running on port ' + this.wsPort);
        console.log('Ready to accept device connections...');
        console.log('================================');
    }

    handleWebSocketMessage(ws, message, clientIP) {
        // Only log important message types to reduce spam
        var importantTypes = ['device_info', 'location_update', 'location_error', 'web_client_connect', 'stop_tracking'];
        if (importantTypes.includes(message.type)) {
            console.log('📨 Received message type: ' + message.type);
        }

        switch (message.type) {
            case 'device_info':
                this.handleDeviceRegistration(ws, message, clientIP);
                break;

            case 'location_update':
                this.handleLocationUpdate(ws, message);
                break;

            case 'location_error':
                this.handleLocationError(ws, message);
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

            case 'pong':
                this.handlePongMessage(ws, message);
                break;

            case 'stop_tracking':
                this.handleStopTracking(ws);
                break;

            case 'device_status':
                this.handleDeviceStatus(ws, message);
                break;

            default:
                console.log('❓ Unknown message type: ' + message.type);
        }
    }

    handleDeviceRegistration(ws, message, clientIP) {
        var deviceId = this.generateDeviceId(message.deviceName, clientIP);
        
        var deviceInfo = {
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

        console.log('📱 Device registered: ' + deviceInfo.deviceName + ' (' + deviceId + ')');

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
        this.printServerStatus();
    }

    handleLocationUpdate(ws, message) {
        var deviceId = ws.deviceId;
        if (!deviceId) {
            this.sendError(ws, 'Device not registered');
            return;
        }

        var device = this.connectedDevices.get(deviceId);
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
        var history = this.locationHistory.get(deviceId);
        history.push(device.location);

        // Keep only last 1000 locations per device
        if (history.length > 1000) {
            history.shift();
        }

        console.log('📍 Location update from ' + device.deviceName + ': ' + 
                   message.latitude.toFixed(6) + ', ' + message.longitude.toFixed(6));

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

    handleLocationError(ws, message) {
        var deviceId = ws.deviceId;
        if (!deviceId) {
            console.log('❌ Location error from unregistered device');
            return;
        }

        var device = this.connectedDevices.get(deviceId);
        if (!device) {
            console.log('❌ Location error from unknown device: ' + deviceId);
            return;
        }

        console.log('❌ Location error from ' + device.deviceName + ': ' + message.error + ' (Code: ' + message.code + ')');
        
        // Update device status
        device.lastError = {
            message: message.error,
            code: message.code,
            timestamp: message.timestamp
        };

        // Broadcast to web clients
        this.broadcastToWebClients({
            type: 'location_error',
            deviceId: deviceId,
            deviceName: device.deviceName,
            error: message.error,
            code: message.code,
            timestamp: message.timestamp
        });

        // Log error to file
        this.logLocationError(deviceId, message);
    }

    handlePongMessage(ws, message) {
        var deviceId = ws.deviceId;
        if (deviceId) {
            var device = this.connectedDevices.get(deviceId);
            if (device) {
                device.lastPong = new Date().toISOString();
                device.latency = Date.now() - new Date(message.timestamp).getTime();
                // console.log('🏓 Pong received from ' + device.deviceName + ' (Latency: ' + device.latency + 'ms)');
            }
        }
    }

    handleDeviceStatus(ws, message) {
        var deviceId = ws.deviceId;
        if (!deviceId) {
            return;
        }

        var device = this.connectedDevices.get(deviceId);
        if (!device) {
            return;
        }

        // Update device status information
        if (message.batteryLevel !== undefined) {
            device.batteryLevel = message.batteryLevel;
        }
        
        if (message.isCharging !== undefined) {
            device.isCharging = message.isCharging;
        }

        if (message.networkType) {
            device.networkType = message.networkType;
        }

        device.lastStatusUpdate = new Date().toISOString();

        console.log('📊 Status update from ' + device.deviceName + 
                   (message.batteryLevel ? ' (Battery: ' + message.batteryLevel + '%)' : ''));

        // Broadcast to web clients
        this.broadcastToWebClients({
            type: 'device_status',
            deviceId: deviceId,
            deviceName: device.deviceName,
            batteryLevel: device.batteryLevel,
            isCharging: device.isCharging,
            networkType: device.networkType,
            timestamp: message.timestamp
        });
    }

    logLocationError(deviceId, errorMessage) {
        var logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        var logEntry = {
            timestamp: new Date().toISOString(),
            deviceId: deviceId,
            error: errorMessage
        };

        fs.appendFileSync(
            path.join(logDir, 'location-errors.log'), 
            JSON.stringify(logEntry) + '\n'
        );
    }

    handleStopTracking(ws) {
        var deviceId = ws.deviceId;
        if (deviceId) {
            var device = this.connectedDevices.get(deviceId);
            if (device) {
                console.log('⏹️ Tracking stopped for ' + device.deviceName);
                
                this.broadcastToWebClients({
                    type: 'tracking_stopped',
                    deviceId: deviceId
                });
            }
        }
    }

    handleWebClientConnection(ws) {
        var self = this;
        this.webClients.add(ws);
        console.log('🖥️ Web client connected. Total: ' + this.webClients.size);

        // Send current device list to new web client
        var devices = Array.from(this.connectedDevices.values()).map(function(device) {
            return self.sanitizeDeviceInfo(device);
        });

        this.sendMessage(ws, {
            type: 'initial_data',
            devices: devices,
            stats: this.getServerStats()
        });

        ws.on('close', function() {
            self.webClients.delete(ws);
            console.log('🖥️ Web client disconnected. Total: ' + self.webClients.size);
        });
    }

    handleDeviceDisconnection(ws) {
        if (ws.deviceId) {
            var device = this.connectedDevices.get(ws.deviceId);
            if (device) {
                console.log('📱 Device disconnected: ' + device.deviceName);
                
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

    generateDeviceId(deviceName, clientIP) {
        var timestamp = Date.now();
        var hash = crypto
            .createHash('md5')
            .update(deviceName + clientIP + timestamp)
            .digest('hex')
            .substring(0, 8);
        
        return deviceName.replace(/\s+/g, '-') + '-' + hash;
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
        
        // Check WebSocket connection first
        if (!device.websocket || device.websocket.readyState !== WebSocket.OPEN) {
            return false;
        }
        
        // Check if last seen is within reasonable time (2 minutes for online status)
        var lastSeen = new Date(device.lastSeen);
        var now = new Date();
        var diffMinutes = (now - lastSeen) / (1000 * 60);
        
        return diffMinutes < 2;
    }

    broadcastToWebClients(message) {
        var messageStr = JSON.stringify(message);
        var self = this;
        
        this.webClients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(messageStr);
                } catch (error) {
                    console.error('Failed to send to web client:', error);
                    self.webClients.delete(client);
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
        var self = this;
        // Example geofence check - customize based on your needs
        var geofences = [
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

        geofences.forEach(function(fence) {
            var distance = self.calculateDistance(
                device.location.latitude,
                device.location.longitude,
                fence.center.lat,
                fence.center.lng
            );

            var isInside = distance <= fence.radius;
            var wasInside = device.lastGeofenceStatus && device.lastGeofenceStatus[fence.name];

            if (isInside && !wasInside && fence.alertOnEntry) {
                self.sendGeofenceAlert(device, fence, 'ENTERED');
            } else if (!isInside && wasInside && fence.alertOnExit) {
                self.sendGeofenceAlert(device, fence, 'EXITED');
            }

            // Update geofence status
            if (!device.lastGeofenceStatus) {
                device.lastGeofenceStatus = {};
            }
            device.lastGeofenceStatus[fence.name] = isInside;
        });
    }

    sendGeofenceAlert(device, fence, action) {
        var alert = {
            type: 'geofence_alert',
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            geofenceName: fence.name,
            action: action,
            timestamp: new Date().toISOString(),
            location: device.location
        };

        console.log('🚨 Geofence Alert: ' + device.deviceName + ' ' + action + ' ' + fence.name);

        // Broadcast to web clients
        this.broadcastToWebClients(alert);

        // Log to file
        this.logAlert(alert);
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        var R = 6371e3; // Earth's radius in meters
        var f1 = lat1 * Math.PI/180;
        var f2 = lat2 * Math.PI/180;
        var df = (lat2-lat1) * Math.PI/180;
        var dl = (lon2-lon1) * Math.PI/180;

        var a = Math.sin(df/2) * Math.sin(df/2) +
                  Math.cos(f1) * Math.cos(f2) *
                  Math.sin(dl/2) * Math.sin(dl/2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

        return R * c; // Distance in meters
    }

    getServerStats() {
        var uptime = new Date() - this.startTime;
        var totalLocations = 0;
        var self = this;

        // Calculate total locations using forEach instead of reduce
        this.locationHistory.forEach(function(history) {
            totalLocations += history.length;
        });

        var onlineDevicesCount = 0;
        this.connectedDevices.forEach(function(device) {
            if (self.isDeviceOnline(device)) {
                onlineDevicesCount++;
            }
        });

        return {
            uptime: uptime,
            uptimeFormatted: this.formatUptime(uptime),
            totalDevices: this.connectedDevices.size,
            onlineDevices: onlineDevicesCount,
            totalLocationUpdates: totalLocations,
            webClients: this.webClients.size,
            memoryUsage: process.memoryUsage(),
            serverTime: new Date().toISOString()
        };
    }

    formatUptime(uptime) {
        var seconds = Math.floor(uptime / 1000);
        var hours = Math.floor(seconds / 3600);
        var minutes = Math.floor((seconds % 3600) / 60);
        var remainingSeconds = seconds % 60;

        return hours.toString().padStart(2, '0') + ':' +
               minutes.toString().padStart(2, '0') + ':' +
               remainingSeconds.toString().padStart(2, '0');
    }

    exportLocationData(format, deviceId) {
        var data = {};
        var self = this;
        
        if (deviceId) {
            var device = this.connectedDevices.get(deviceId);
            var history = this.locationHistory.get(deviceId);
            
            if (!device || !history) {
                throw new Error('Device not found or no location history');
            }
            
            data[deviceId] = {
                device: this.sanitizeDeviceInfo(device),
                locations: history
            };
        } else {
            // Export all devices
            this.connectedDevices.forEach(function(device, id) {
                data[id] = {
                    device: self.sanitizeDeviceInfo(device),
                    locations: self.locationHistory.get(id) || []
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
        var csv = 'DeviceID,DeviceName,Timestamp,Latitude,Longitude,Accuracy,Speed,Heading\n';
        
        Object.keys(data).forEach(function(deviceId) {
            var deviceData = data[deviceId];
            deviceData.locations.forEach(function(location) {
                csv += deviceId + ',' + 
                       deviceData.device.deviceName + ',' + 
                       location.timestamp + ',' + 
                       location.latitude + ',' + 
                       location.longitude + ',' + 
                       (location.accuracy || '') + ',' + 
                       (location.speed || '') + ',' + 
                       (location.heading || '') + '\n';
            });
        });

        return csv;
    }

    convertToGPX(data) {
        var gpx = '<?xml version="1.0" encoding="UTF-8"?>\n' +
                  '<gpx version="1.1" creator="Location Tracking Server">\n' +
                  '<metadata>\n' +
                  '    <name>Location Tracking Export</name>\n' +
                  '    <time>' + new Date().toISOString() + '</time>\n' +
                  '</metadata>\n';

        Object.keys(data).forEach(function(deviceId) {
            var deviceData = data[deviceId];
            if (deviceData.locations.length === 0) return;

            gpx += '<trk>\n' +
                   '    <name>' + deviceData.device.deviceName + '</name>\n' +
                   '    <trkseg>\n';

            deviceData.locations.forEach(function(location) {
                gpx += '        <trkpt lat="' + location.latitude + '" lon="' + location.longitude + '">\n' +
                       '            <time>' + location.timestamp + '</time>';
                
                if (location.altitude) {
                    gpx += '<ele>' + location.altitude + '</ele>';
                }
                
                gpx += '</trkpt>\n';
            });

            gpx += '    </trkseg>\n' +
                   '</trk>\n';
        });

        gpx += '</gpx>';
        return gpx;
    }

    startPeriodicTasks() {
        var self = this;
        
        // Cleanup disconnected devices periodically
        this.cleanupInterval = setInterval(function() {
            self.cleanupDisconnectedDevices();
        }, 5 * 60 * 1000); // Every 5 minutes

        // Send ping to all connected devices (reduced frequency)
        this.pingInterval = setInterval(function() {
            self.pingAllDevices();
        }, 60 * 1000); // Every 60 seconds instead of 30

        // Save statistics periodically
        this.statsInterval = setInterval(function() {
            self.saveStatsToFile();
        }, 10 * 60 * 1000); // Every 10 minutes

        console.log('⏰ Periodic tasks started (Ping: 60s, Cleanup: 5min, Stats: 10min)');
    }

    cleanupDisconnectedDevices() {
        var now = new Date();
        var maxOfflineTime = 30 * 60 * 1000; // 30 minutes
        var self = this;

        this.connectedDevices.forEach(function(device, deviceId) {
            if (!self.isDeviceOnline(device)) {
                var lastSeen = new Date(device.lastSeen);
                if (now - lastSeen > maxOfflineTime) {
                    console.log('🗑️ Removing inactive device: ' + device.deviceName);
                    self.connectedDevices.delete(deviceId);
                    
                    // Optionally keep location history or remove it too
                    // self.locationHistory.delete(deviceId);
                }
            }
        });
    }

    pingAllDevices() {
        var self = this;
        var pingCount = 0;
        
        this.connectedDevices.forEach(function(device) {
            if (device.websocket && device.websocket.readyState === WebSocket.OPEN) {
                self.sendMessage(device.websocket, {
                    type: 'ping',
                    timestamp: new Date().toISOString()
                });
                pingCount++;
            }
        });

        if (pingCount > 0) {
            console.log('🏓 Pinged ' + pingCount + ' devices');
        }
    }

    saveDeviceToFile(deviceInfo) {
        var logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        var logEntry = {
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
        var logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        var today = new Date().toISOString().slice(0, 10);
        var filename = 'locations-' + today + '.log';

        var logEntry = {
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
        var logDir = './logs';
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        fs.appendFileSync(
            path.join(logDir, 'alerts.log'), 
            JSON.stringify(alert) + '\n'
        );
    }

    saveStatsToFile() {
        var stats = this.getServerStats();
        var logDir = './logs';
        
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir);
        }

        var statsEntry = Object.assign({}, stats);
        statsEntry.timestamp = new Date().toISOString();

        fs.appendFileSync(
            path.join(logDir, 'server-stats.log'), 
            JSON.stringify(statsEntry) + '\n'
        );
    }

    printServerStatus() {
        var stats = this.getServerStats();
        console.log('📊 Server Status - Devices: ' + stats.onlineDevices + '/' + stats.totalDevices + 
                   ' | Web Clients: ' + stats.webClients + 
                   ' | Uptime: ' + stats.uptimeFormatted);
    }

    // Graceful shutdown
    shutdown() {
        console.log('🔄 Shutting down server...');

        // Close WebSocket server
        this.wss.clients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN) {
                client.close(1000, 'Server shutdown');
            }
        });
        this.wss.close();

        // Close HTTP server
        this.server.close();

        // Clear intervals
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.statsInterval) clearInterval(this.statsInterval);

        console.log('✅ Server shutdown complete');
        process.exit(0);
    }
}

// Initialize server
const port = process.env.PORT || 4000;
var server = new LocationTrackingServer(port, port);


// Handle graceful shutdown
process.on('SIGINT', function() {
    server.shutdown();
});

process.on('SIGTERM', function() {
    server.shutdown();
});

// Handle uncaught exceptions
process.on('uncaughtException', function(error) {
    console.error('❌ Uncaught Exception:', error);
    server.shutdown();
});

process.on('unhandledRejection', function(reason, promise) {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    server.shutdown();
});

module.exports = LocationTrackingServer;