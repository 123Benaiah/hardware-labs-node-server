const express = require('express');
const WebSocket = require('ws');
const os = require('os');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const path = require('path');

// Initialize Firebase
const serviceAccount = require('./firebase-config.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://hardware-esp32-default-rtdb.firebaseio.com"
});
const db = admin.database();

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration
app.use(cors({
  origin: ['http://localhost', 'http://192.168.8.100', 'http://127.0.0.1', '*'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Middleware
app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan(':method :url :status :response-time ms - :res[content-length]'));

// Serve static files (for frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

// ESP32 Configuration
const ESP32_IP = '192.168.1.100'; // Update with your ESP32's IP
const ESP32_PORT = '80';
const ESP32_DOOR_ENDPOINT = '/door';

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

// WebSocket broadcast function
function broadcast(message) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        command: message === 'on' ? 'light_on' : 'light_off',
        timestamp: new Date().toISOString()
      }));
    }
  });
}

// Enhanced bulb control endpoints
app.get('/on', (req, res) => {
  bulbState = 'on';
  sensorData.bulbState = true;
  
  // Broadcast to all WebSocket clients
  broadcast('on');
  
  // Update Firebase
  updateFirebase();
  
  console.log('Bulb ON command sent to all clients');
  res.json({
    status: 'success',
    message: 'Bulb turned ON',
    currentState: bulbState,
    timestamp: new Date().toISOString()
  });
});

app.get('/off', (req, res) => {
  bulbState = 'off';
  sensorData.bulbState = false;
  
  // Broadcast to all WebSocket clients
  broadcast('off');
  
  // Update Firebase
  updateFirebase();
  
  console.log('Bulb OFF command sent to all clients');
  res.json({
    status: 'success',
    message: 'Bulb turned OFF',
    currentState: bulbState,
    timestamp: new Date().toISOString()
  });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`New client connected (${clients.size} total)`);
  
  // Send current state on connection
  ws.send(JSON.stringify({
    type: 'init',
    bulbState: bulbState,
    timestamp: new Date().toISOString()
  }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.command === 'light_on') {
        bulbState = 'on';
        broadcast('on');
      } 
      else if (data.command === 'light_off') {
        bulbState = 'off';
        broadcast('off');
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });
  
  // Handle disconnections
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} remaining)`);
  });
});

app.get('/status', (req, res) => {
  res.json({
    state: bulbState,
    connectedClients: clients.size,
    serverPort: server.address().port
  });
});

// Sensor data endpoints
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

// Face Recognition endpoint
app.post('/api/face-recognition', async (req, res) => {
  try {
    const { type, status, user, servoPin } = req.body;
    
    // Validate required fields
    if (!type || !status || !user) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields'
      });
    }
    
    const now = new Date();
    
    // Store face recognition event in Firebase
    const eventRef = db.ref('face_events').push();
    await eventRef.set({
      type,
      status,
      user,
      servoPin: servoPin || 2, // Default to pin 2 if not specified
      timestamp: Math.floor(now.getTime() / 1000),
      datetime: now.toISOString(),
      device: 'Web_Face_Recognition'
    });
    
    console.log(`👤 Face Recognition Event: ${status} | User: ${user}`);
    
    // Forward command to ESP32
    let esp32Response = { success: false };
    try {
      const esp32Url = `http://${ESP32_IP}:${ESP32_PORT}${ESP32_DOOR_ENDPOINT}`;
      const response = await fetch(esp32Url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type,
          status,
          user,
          servoPin: servoPin || 2
        })
      });
      
      if (response.ok) {
        esp32Response = await response.json();
        console.log('✅ Command successfully forwarded to ESP32');
      } else {
        console.error('❌ Failed to forward command to ESP32:', response.status);
      }
    } catch (esp32Error) {
      console.error('❌ Error forwarding to ESP32:', esp32Error);
    }
    
    // Broadcast face recognition event to WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'face_event',
          status,
          user,
          timestamp: now.toISOString()
        }));
      }
    });
    
    res.status(200).json({
      status: 'success',
      message: 'Face recognition event processed',
      user,
      accessGranted: status === 'granted',
      esp32Response
    });
    
  } catch (error) {
    console.error('❌ Face recognition error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Add endpoint to retrieve face recognition events
app.get('/api/face-events', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const snapshot = await db.ref('face_events')
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
      data: events.reverse()
    });
    
  } catch (error) {
    console.error('❌ Face events fetch error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error'
    });
  }
});

// RFID implementation
app.post('/api/rfid-event', async (req, res) => {
  try {
    const { status, tag } = req.body;
    const now = new Date();
    
    // Update bulb state based on RFID scan
    if (status === 'granted access') {
      bulbState = 'on';
      sensorData.bulbState = true;
    } else {
      bulbState = 'off';
      sensorData.bulbState = false;
    }
    
    // Store RFID event in Firebase
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
      data: events.reverse()
    });
    
  } catch (error) {
    console.error('❌ RFID events fetch error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Internal server error'
    });
  }
});

// Receive Keypad Events
app.post('/api/keypad-events', async (req, res) => {
  const data = req.body;
  console.log("Received Keypad Event:", data);
  try {
    const ref = db.ref('keypad_events').push();
    await ref.set({
      type: data.type || "keypad",
      status: data.status || "",
      pin: data.pin || "",
      timestamp: Date.now()
    });
    res.status(200).json({ message: "Keypad event stored in Firebase." });
  } catch (err) {
    console.error("Error writing to Firebase:", err);
    res.status(500).json({ error: "Failed to store keypad event." });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'running',
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    ip: getIPAddress(),
    port: PORT
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