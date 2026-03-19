require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const errorHandler = require('./middleware/errorHandler');
const db = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const registrationRoutes = require('./routes/registration');
const invitesRoutes = require('./routes/invites');
const verificationRoutes = require('./routes/verification');
const virtualPlayersRoutes = require('./routes/virtual-players');
const privateCoachesRoutes = require('./routes/private-coaches');
const migrateRoutes = require('./routes/migrate');
const playersRoutes = require('./routes/players');
const teamsRoutes = require('./routes/teams');
const clubsRoutes = require('./routes/clubs');
const trainingsRoutes = require('./routes/trainings');
const exercisesRoutes = require('./routes/exercises');
const matchesRoutes = require('./routes/matches');
const testsRoutes = require('./routes/tests');
const attendanceRoutes = require('./routes/attendance');
const uploadsRoutes = require('./routes/uploads');
const coachesRoutes = require('./routes/coaches');
const clubPermissionsRoutes = require('./routes/club-permissions');
const metricsRoutes = require('./routes/metrics');
const { getStorageMode, isCloudinaryConfigured } = require('./services/fileStorage');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

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
app.use('/api/registration', registrationRoutes);
app.use('/api/invites', invitesRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/virtual-players', virtualPlayersRoutes);
app.use('/api/private-coaches', privateCoachesRoutes);
app.use('/api/migrate', migrateRoutes);
app.use('/api/clubs', clubsRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/trainings', trainingsRoutes);
app.use('/api/exercises', exercisesRoutes);
app.use('/api/matches', matchesRoutes);
app.use('/api/tests', testsRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/coaches', coachesRoutes);
app.use('/api/club-permissions', clubPermissionsRoutes);
app.use('/api', metricsRoutes);

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
const startServer = async () => {
  const storageMode = getStorageMode();

  if (process.env.NODE_ENV === 'production' && !isCloudinaryConfigured()) {
    console.error('❌ Production upload storage is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.');
    process.exit(1);
  }

  try {
    await db.ensureCoreTables();
  } catch (error) {
    console.error('⚠️ Failed to initialize core tables before startup:', error.message);
  }

  app.listen(PORT, () => {
    console.log('🚀 Sports Club API Server');
    console.log(`📡 Running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Database: ${process.env.DB_HOST}/${process.env.DB_NAME}`);
    console.log(`🗂️ Upload storage: ${storageMode}`);
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
    console.log('   GET    /api/metrics');
    console.log('   POST   /api/metrics');
    console.log('   PUT    /api/metrics/:id');
    console.log('   DELETE /api/metrics/:id');
    console.log('   POST   /api/metrics/validate-formula');
  });
};

startServer();

module.exports = app;
