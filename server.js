const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Store sensor data
let sensorData = {
  temperature: 0,
  humidity: 0,
  timestamp: '',
  datetime: '',
  bulbState: false
};

// Endpoint for ESP32 to post data
app.post('/api/sensor-data', (req, res) => {
  try {
    const { temperature, humidity, timestamp, datetime } = req.body;
    
    if (temperature === undefined || humidity === undefined) {
      return res.status(400).json({ error: 'Temperature and humidity are required' });
    }

    sensorData = {
      ...sensorData,
      temperature: parseFloat(temperature),
      humidity: parseFloat(humidity),
      timestamp: timestamp || Date.now().toString(),
      datetime: datetime || new Date().toISOString()
    };
    
    console.log('Received sensor data:', sensorData);
    res.status(200).json({ message: 'Data received successfully' });
  } catch (error) {
    console.error('Error processing sensor data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to control bulb state
app.post('/api/bulb', (req, res) => {
  try {
    const { state } = req.body;
    
    if (typeof state !== 'boolean') {
      return res.status(400).json({ error: 'State must be a boolean' });
    }

    sensorData.bulbState = state;
    console.log('Bulb state updated:', state);
    res.status(200).json({ message: 'Bulb state updated', bulbState: state });
  } catch (error) {
    console.error('Error updating bulb state:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint for Flutter app to get data
app.get('/api/sensor-data', (req, res) => {
  try {
    res.status(200).json(sensorData);
  } catch (error) {
    console.error('Error fetching sensor data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Endpoint to get bulb state
app.get('/api/bulb', (req, res) => {
  try {
    res.status(200).json({ bulbState: sensorData.bulbState });
  } catch (error) {
    console.error('Error fetching bulb state:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});