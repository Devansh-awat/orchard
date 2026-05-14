import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import cookieParser from 'cookie-parser';
import { attachTerminalWebSocket } from './kubernetes/terminal.gateway';

dotenv.config();
const envPath1 = resolve(process.cwd(), '..', '.env');
dotenv.config({ path: envPath1, override: false });
const envPath2 = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath2, override: false });

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function() {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('apiv1');

  app.use(cookieParser());

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const baseDomain = process.env.BASE_DOMAIN; // e.g. "orchard.my"

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-to-server, curl)
      if (!origin) return callback(null, true);

      // Allow the main frontend URL
      if (origin === frontendUrl) return callback(null, true);

      // Allow any subdomain of the base domain
      if (baseDomain) {
        const escapedDomain = baseDomain.replace(/\./g, '\\.');
        const subdomainPattern = new RegExp(`^https?://[a-z0-9-]+\\.${escapedDomain}$`);
        if (subdomainPattern.test(origin)) return callback(null, true);
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);

  // Attach WebSocket terminal handler to the underlying HTTP server
  const httpServer = app.getHttpServer();
  attachTerminalWebSocket(httpServer, app);

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}

bootstrap();

