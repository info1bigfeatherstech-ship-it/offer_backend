// /**
//  * PM2 ecosystem file. Run with:
//  *   pm2 start config/ecosystem.config.js --env production
//  *
//  * Notes:
//  *   - Default is fork mode with 1 instance because:
//  *       1. express-rate-limit uses in-memory store -> cluster duplicates limits.
//  *       2. Redis Cloud / managed Redis free tiers cap concurrent connections.
//  *       3. Cleanup + payment-hold schedulers are gated to NODE_APP_INSTANCE=0
//  *          but fork mode keeps things simpler when not needed.
//  *   - To scale, override at start time:
//  *       PM2_INSTANCES=2 pm2 start config/ecosystem.config.js --env production
//  *     or change `instances` here to a number (or 'max') and ensure your
//  *     Redis / Mongo connection limits can absorb the multiplier.
//  */

// const instancesFromEnv = String(process.env.PM2_INSTANCES || '').trim();
// let resolvedInstances = 1;
// if (instancesFromEnv) {
//   if (instancesFromEnv.toLowerCase() === 'max') {
//     resolvedInstances = 'max';
//   } else if (/^\d+$/.test(instancesFromEnv)) {
//     resolvedInstances = Number.parseInt(instancesFromEnv, 10);
//   }
// }

// const execMode = resolvedInstances === 1 ? 'fork' : 'cluster';

// module.exports = {
//   apps: [{
//     name: 'ecommerce-api',
//     script: './index.js',
//     cwd: __dirname.replace(/[\\/]config$/, ''),
//     instances: resolvedInstances,
//     exec_mode: execMode,
//     watch: false,
//     autorestart: true,
//     max_restarts: 10,
//     min_uptime: '30s',
//     max_memory_restart: '2G',
//     env: {
//       NODE_ENV: 'production',
//       PORT: 4000
//     },
//     error_file: './logs/pm2-error.log',
//     out_file: './logs/pm2-out.log',
//     log_file: './logs/pm2-combined.log',
//     merge_logs: true,
//     time: true,
//     kill_timeout: 30000,
//     listen_timeout: 10000,
//     shutdown_with_message: true,
//     wait_ready: false,
//     node_args: '--max-old-space-size=2048'
//   }]
// };


/**
 * PM2 ecosystem file. Run with:
 *   pm2 start config/ecosystem.config.js --env production
 *
 * Notes:
 *   - Default is fork mode with 1 instance because:
 *       1. express-rate-limit uses in-memory store -> cluster duplicates limits.
 *       2. Redis Cloud / managed Redis free tiers cap concurrent connections.
 *       3. Cleanup + payment-hold schedulers are gated to NODE_APP_INSTANCE=0
 *          but fork mode keeps things simpler when not needed.
 *   - To scale, override at start time:
 *       PM2_INSTANCES=2 pm2 start config/ecosystem.config.js --env production
 *     or change `instances` here to a number (or 'max') and ensure your
 *     Redis / Mongo connection limits can absorb the multiplier.
 */

const instancesFromEnv = String(process.env.PM2_INSTANCES || '').trim();
let resolvedInstances = 1;
if (instancesFromEnv) {
  if (instancesFromEnv.toLowerCase() === 'max') {
    resolvedInstances = 'max';
  } else if (/^\d+$/.test(instancesFromEnv)) {
    resolvedInstances = Number.parseInt(instancesFromEnv, 10);
  }
}

const execMode = resolvedInstances === 1 ? 'fork' : 'cluster';

// PM2 `--env production` merges `env_production` over `env`; define both so the flag is valid.
const prodEnv = {
  NODE_ENV: 'production',
  PORT: 4000
};

module.exports = {
  apps: [{
    name: 'ecommerce-api',
    script: './index.js',
    cwd: __dirname.replace(/[\\/]config$/, ''),
    instances: resolvedInstances,
    exec_mode: execMode,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '30s',
    max_memory_restart: '2G',
    env: { ...prodEnv },
    env_production: { ...prodEnv },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    merge_logs: true,
    time: true,
    kill_timeout: 30000,
    listen_timeout: 10000,
    shutdown_with_message: true,
    wait_ready: false,
    node_args: '--max-old-space-size=2048'
  }]
};
