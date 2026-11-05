import { config } from './config.js';
import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';

await migrate();
await seed();
const app = await buildApp();
await app.listen({ port: config.PORT, host: config.HOST });
console.log(`api listening on :${config.PORT}`);
