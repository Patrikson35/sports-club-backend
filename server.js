require('dotenv').config();
const express = require('express');
const cors = require('cors');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const authRoutes = require('./routes/auth');
const playersRoutes = require('./routes/players');
const teamsRoutes = require('./routes/teams');
const trainingsRoutes = require('./routes/trainings');
const exercisesRoutes = require('./routes/exercises');
const matchesRoutes = require('./routes/matches');
const testsRoutes = require('./routes/tests');
const attendanceRoutes = require('./routes/attendance');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging (development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/trainings', trainingsRoutes);
app.use('/api/exercises', exercisesRoutes);
app.use('/api/matches', matchesRoutes);
app.use('/api/tests', testsRoutes);
app.use('/api/attendance', attendanceRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path
  });
});

// Global error handler
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log('🚀 Sports Club API Server');
  console.log(`📡 Running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Database: ${process.env.DB_HOST}/${process.env.DB_NAME}`);
  console.log(`✅ Server started at ${new Date().toISOString()}`);
  console.log('\n📚 Available endpoints:');
  console.log('   POST   /api/auth/login');
  console.log('   POST   /api/auth/register');
  console.log('   GET    /api/players');
  console.log('   GET    /api/players/:id');
  console.log('   GET    /api/teams');
  console.log('   GET    /api/teams/:id/players');
  console.log('   GET    /api/trainings');
  console.log('   GET    /api/trainings/:id');
  console.log('   POST   /api/trainings');
  console.log('   GET    /api/exercises');
  console.log('   GET    /api/exercises/categories');
  console.log('   GET    /api/matches');
  console.log('   GET    /api/matches/:id/lineup');
  console.log('   GET    /api/matches/:id/events');
  console.log('   GET    /api/tests/categories');
  console.log('   GET    /api/tests/results');
  console.log('   POST   /api/tests/results');
  console.log('   GET    /api/tests/players/:id');
  console.log('   GET    /api/tests/stats/:categoryType');
  console.log('   GET    /api/attendance/:trainingId');
  console.log('   POST   /api/attendance');
  console.log('   GET    /api/attendance/player/:playerId');
});

module.exports = app;
