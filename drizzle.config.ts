import { defineConfig } from 'drizzle-kit';
import { config } from './src/config.ts';

export default defineConfig({
    out: process.env.MIGRATIONS_DIR ?? './drizzle',
    schema: './src/db/schema.ts',
    dialect: 'postgresql',
    dbCredentials: {
        url: config.database.url
    }
});
