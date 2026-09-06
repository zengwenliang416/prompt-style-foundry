import { buildApp } from './bootstrap/app.js';
import { ConfigError, loadConfig } from './config/env.js';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    // Issue messages never contain secret values (see config/env.ts policy).
    console.error(JSON.stringify({ event: 'config_invalid', issues: error.issues }, null, 2));
    process.exit(1);
  }
  throw error;
}

const app = buildApp(config);

const shutdownSignals = ['SIGINT', 'SIGTERM'] as const;
for (const signal of shutdownSignals) {
  process.on(signal, () => {
    app.log.info({ event: 'api_shutdown', signal });
    void app.close().finally(() => {
      process.exit(0);
    });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ event: 'api_started', runMode: config.runMode });
} catch (error) {
  app.log.error({ event: 'api_listen_failed', error });
  process.exit(1);
}
