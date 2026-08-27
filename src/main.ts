import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown keys and reject rather than ignore them: a client sending
      // `amount` instead of `amountMinor` should get an error, not a silent
      // transfer of undefined.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Envelope every response in { statusCode, data, message, timestamp }.
  // The filter mirrors the interceptor so success and failure parse alike.
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Send Money Limits Module')
    .setDescription('SEND MONEY transactions with per-user spending limits API')
    .setVersion('1.0')
    .addTag('send-money')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, documentFactory);

  if (process.env.NODE_ENV !== 'production') {
    Logger.warn(
      `NODE_ENV=${process.env.NODE_ENV ?? 'unset'} — POST /v1/dev/token is ENABLED and mints access tokens for any seeded identity without a password. Never run this configuration in production.`,
      'Bootstrap',
    );
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
