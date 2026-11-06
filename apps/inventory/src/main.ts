import { bootstrapService } from '@jewelry/common';
import { AppModule } from './app.module';
import { SERVICE_NAME } from './config/env';

void bootstrapService({ service: SERVICE_NAME, module: AppModule });
