  const mongoose = require('mongoose');

  // ============================================================================
  // CONNECTION MANAGERS WITH RETRY LOGIC
  // ============================================================================

  let mongoConnection = null;

  // Connection retry configuration
  const MONGODB_RETRY_CONFIG = {
    maxRetries: 5,
    retryDelay: 5000,
    backoffMultiplier: 2
  };

  /**
   * MongoDB Connection with Exponential Backoff Retry
   */
  async function connectMongoDB(retryCount = 0) {
    try {
      console.log(`[MongoDB] Attempting connection... (Attempt ${retryCount + 1}/${MONGODB_RETRY_CONFIG.maxRetries})`);
      // console.log("db url", process.env.MONGO_DB_URI);
      
      const connection = await mongoose.connect(process.env.MONGO_DB_URI, {
        // Replica set configuration
        // readPreference: 'secondaryPreferred',
        retryWrites: true,
        w: 'majority',
        
        // Connection pool configuration
        maxPoolSize: 50,
        minPoolSize: 10,
        socketTimeoutMS: 45000,
        serverSelectionTimeoutMS: 10000,
        
        // Heartbeat configuration
        heartbeatFrequencyMS: 10000,
      });
          
      // Production-safe default: do NOT auto-sync indexes on every cold start.
      // syncIndexes() on a large Product collection can lock writes for minutes
      // and may drop manually-created indexes that aren't in the schema.
      // Opt-in explicitly by setting MONGODB_SYNC_PRODUCT_INDEXES=true for the
      // single deploy where schema indexes actually changed, then flip back.
      const syncProductIndexes =
        String(process.env.MONGODB_SYNC_PRODUCT_INDEXES || 'false').toLowerCase() === 'true';
      if (syncProductIndexes) {
        const Product = require('../models/Product');
        await Product.syncIndexes();
        console.log('[MongoDB] ✓ Product indexes synced');
      } else {
        console.log('[MongoDB] Product index sync skipped (set MONGODB_SYNC_PRODUCT_INDEXES=true to force)');
      }


      mongoConnection = connection;
      console.log('[MongoDB] ✓ Connected successfully');
      console.log(`[MongoDB] Database: ${connection.connection.db.databaseName}`);
      // console.log(`[MongoDB] Read Preference: secondaryPreferred`);
      // console.log(`[MongoDB] Read Preference: ${connection.connection.readPreference.mode}`);

      return connection;
    } catch (error) {
      console.error(`[MongoDB] ✗ Connection failed:`, error.message);
      
      if (retryCount < MONGODB_RETRY_CONFIG.maxRetries) {
        const delay = MONGODB_RETRY_CONFIG.retryDelay * Math.pow(MONGODB_RETRY_CONFIG.backoffMultiplier, retryCount);
        console.log(`[MongoDB] Retrying in ${delay / 1000} seconds...`);
        
        await new Promise(resolve => setTimeout(resolve, delay));
        return connectMongoDB(retryCount + 1);
      } else {
        console.error('[MongoDB] ✗ Max retry attempts reached. Exiting...');
        process.exit(1);
      }
    }
  }


  /**
   * MongoDB Event Handlers for Runtime Errors
   */
  function setupMongoDBEventHandlers() {
    mongoose.connection.on('error', (err) => {
      console.error('[MongoDB] Runtime error:', err.message);
      // Log but don't crash - driver will handle reconnection
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('[MongoDB] Disconnected from database');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('[MongoDB] ✓ Reconnected to database');
    });

    mongoose.connection.on('close', () => {
      console.log('[MongoDB] Connection closed');
    });
  }

  module.exports = {
    connectMongoDB,
    setupMongoDBEventHandlers,
    mongoConnection
  };

