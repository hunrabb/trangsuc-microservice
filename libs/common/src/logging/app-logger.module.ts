import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { getCorrelationId } from '../correlation/correlation-id';
import { buildLoggerOptions } from './logger-options';

@Module({})
export class AppLoggerModule {
  static forRoot(service: string): DynamicModule {
    return {
      module: AppLoggerModule,
      imports: [LoggerModule.forRoot({ pinoHttp: buildLoggerOptions(service, getCorrelationId) })],
    };
  }
}
