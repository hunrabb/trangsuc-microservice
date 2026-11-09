import { PrismaPg } from '@prisma/adapter-pg';
import { postgresUrlField } from '@jewelry/common';
import { PrismaClient } from '../generated/prisma/client';
import { CatalogPublisher } from '../catalog/catalog-publisher';
import type { PrismaService } from '../prisma/prisma.service';

async function main() {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* Container dùng env. */
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg(
      { connectionString: postgresUrlField('inventory').parse(process.env.DATABASE_URL), max: 2 },
      { schema: 'inventory' },
    ),
  });
  try {
    await new CatalogPublisher(prisma as PrismaService).replay();
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
