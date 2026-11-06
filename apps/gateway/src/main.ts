import { bootstrapService } from '@jewelry/common';
import { AppModule } from './app.module';
import { SERVICE_NAME } from './config/env';
import { INTERNAL_PREFIX, blockInternal } from './security/block-internal';

void bootstrapService({
  service: SERVICE_NAME,
  module: AppModule,
  // Đăng ký trước mọi định tuyến khác: /internal/* không bao giờ ra khỏi gateway.
  configure: (app) => app.use(INTERNAL_PREFIX, blockInternal),
});
