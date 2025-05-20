const express = require('express');
const WebSocket = require('ws');
const os = require('os');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');
const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('./firebase-config.json'); // Ensure this path is correct
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://hardware-esp32-default-rtdb.firebaseio.com"
});
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['http://localhost', 'http://172.16.23.17'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :response-time ms - :res[content-length]'));

// Get network IP
function getIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://${getIPAddress()}:${PORT}`);
});

// WebSocket server for bulb control
const wss = new WebSocket.Server({ server });
let bulbState = 'off';
const clients = new Set();

// Sensor data state
let sensorData = {
  temperature: 0,
  humidity: 0,
  timestamp: '',
  datetime: '',
  bulbState: false,
  lastUpdated: null
};

// WebSocket connection handler
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`New client connected (${clients.size} total)`);

  // Send current state when client connects
  ws.send(bulbState);
  console.log(`Sent initial state: ${bulbState}`);

  // Handle client messages
  ws.on('message', (message) => {
    console.log(`Received from ESP32: ${message}`);

    if (message.toString().includes('status:')) {
      bulbState = message.toString().split(':')[1];
      console.log(`Bulb status updated to: ${bulbState}`);
      sensorData.bulbState = bulbState === 'on';
      updateFirebase();
    }
  });

  // Handle disconnections
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} remaining)`);
  });
});

// Update Firebase with current state
async function updateFirebase() {
  try {
    // Update bulb state separately
    await db.ref('bulb_state').set(sensorData.bulbState);
    
    // Update sensor data separately
    await db.ref('sensors/environment').set({
      temperature: sensorData.temperature,
      humidity: sensorData.humidity,
      timestamp: sensorData.timestamp,
      datetime: sensorData.datetime
    });
    
    console.log('🔥 Firebase updated successfully (non-destructive)');
  } catch (error) {
    console.error('❌ Firebase update error:', error);
  }
}

// Broadcast to all WebSocket clients
function broadcast(message) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Bulb control endpoints (from code 1)
app.get('/on', (req, res) => {
  bulbState = 'on';
  sensorData.bulbState = true;
  broadcast('on');
  updateFirebase();
  console.log('Bulb ON command sent to all clients');
  res.send(`Bulb turned ON. Current state: ${bulbState}`);
});

app.get('/off', (req, res) => {
  bulbState = 'off';
  sensorData.bulbState = false;
  broadcast('off');
  updateFirebase();
  console.log('Bulb OFF command sent to all clients');
  res.send(`Bulb turned OFF. Current state: ${bulbState}`);
});

app.get('/status', (req, res) => {
  res.json({
    state: bulbState,
    connectedClients: clients.size,
    serverPort: server.address().port
  });
});

// Sensor data endpoints (from code 2)
app.post('/api/sensor-data', async (req, res) => {
  try {
    const { temperature, humidity, timestamp, datetime } = req.body;
    const now = new Date();

    sensorData = {
      temperature: parseFloat(temperature.toFixed(1)),
      humidity: parseFloat(humidity.toFixed(1)),
      timestamp: timestamp || Math.floor(now.getTime() / 1000),
      datetime: datetime || now.toISOString(),
      bulbState: sensorData.bulbState,
      lastUpdated: now
    };

    await updateFirebase();
    
    console.log('📡 Received and synced sensor data:', {
      ...sensorData,
      receivedAt: new Date().toISOString()
    });

    res.status(200).json({
      status: 'success',
      message: 'Sensor data synced to Firebase',
      receivedData: {
        temperature: sensorData.temperature,
        humidity: sensorData.humidity
      }
    });

  } catch (error) {
    console.error('❌ Sensor data error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Additional API endpoints (from code 2)
app.get('/api/sensor-data', (req, res) => {
  try {
    res.status(200).json({
      status: 'success',
      data: sensorData,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Data fetch error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error'
    });
  }
});
//rfid implementation
// RFID Event endpoint
app.post('/api/rfid-event', async (req, res) => {
  try {
    const { status, tag } = req.body; // Removed bulb state reference
    const now = new Date();
      // Update bulb state based on RFID scan
    if (status === 'granted access') {
      bulbState = 'on';
      sensorData.bulbState = true;
    } else {
      bulbState = 'off';
      sensorData.bulbState = false;
    }
    
    // Store RFID event in Firebase (without bulb state)
    const eventRef = db.ref('rfid_events').push();
    await eventRef.set({
      status,
      tag,
      timestamp: Math.floor(now.getTime() / 1000),
      datetime: now.toISOString(),
      device: 'ESP32_RFID_Reader'
    });
    
    console.log(`🔑 RFID Event: ${status} | Tag: ${tag}`);
    
    res.status(200).json({
      status: 'success',
      message: 'RFID event recorded'
    });
    
  } catch (error) {
    console.error('❌ RFID event error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Get latest RFID events with pagination
app.get('/api/rfid-events', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const snapshot = await db.ref('rfid_events')
      .orderByChild('timestamp')
      .limitToLast(limit)
      .once('value');
    
    const events = [];
    snapshot.forEach(childSnapshot => {
      events.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });
    
    res.status(200).json({
      status: 'success',
      count: events.length,
      data: events.reverse() // Newest first
    });
    
  } catch (error) {
    console.error('❌ RFID events fetch error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error'
    });
  }
});

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'running',
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🔥 Server error:', err);
  res.status(500).json({
    status: 'error',
    error: 'Internal server error',
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

console.log(`🌐 WebSocket server running on ws://${getIPAddress()}:${PORT}`);