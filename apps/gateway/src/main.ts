import { bootstrapService } from '@jewelry/common';
import { AppModule } from './app.module';
import { SERVICE_NAME } from './config/env';

// Tắt body parser: gateway chuyển tiếp nguyên byte (webhook ngân hàng cần body gốc để kiểm chữ ký).
void bootstrapService({ service: SERVICE_NAME, module: AppModule, bodyParser: false });
