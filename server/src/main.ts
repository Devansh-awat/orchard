import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import { resolve } from 'path';
import cookieParser from 'cookie-parser';

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

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  });

  const port = process.env.PORT || 3001;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
}

bootstrap();

