import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { accountEmail } from '../src/users/account-scope';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: {
      name: 'admin',
      description: 'Full administrative access to a project'
    }
  });

  await prisma.role.upsert({
    where: { name: 'member' },
    update: {},
    create: {
      name: 'member',
      description: 'Standard member access to a project'
    }
  });

  await prisma.role.upsert({
    where: { name: 'viewer' },
    update: {},
    create: {
      name: 'viewer',
      description: 'Read-only access to a project'
    }
  });

  console.log('✅ Created roles: admin, member, viewer');

  const passwordHash = await bcrypt.hash('password123', 10);

  const user = await prisma.user.upsert({
    where: accountEmail('admin@orchard.dev'),
    update: { setupCompleted: true },
    create: {
      email: 'admin@orchard.dev',
      username: 'orchard-admin',
      passwordHash,
      firstName: 'Orchard',
      lastName: 'Admin',
      setupCompleted: true
    }
  });

  console.log('✅ Created user: admin@orchard.dev');

  const organization = await prisma.organization.upsert({
    where: { slug: 'orchard-demo' },
    update: {},
    create: {
      name: 'Orchard Demo',
      slug: 'orchard-demo',
      description: 'Orchard Demo organization',
      createdBy: user.id
    }
  });

  console.log('✅ Created organization: Orchard Demo');

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id
      }
    },
    update: {},
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: 'owner',
      addedBy: user.id
    }
  });

  console.log('✅ Added user to organization as owner');

  const project = await prisma.project.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: 'midnight'
      }
    },
    update: {},
    create: {
      organizationId: organization.id,
      name: 'Midnight',
      slug: 'midnight',
      namespace: 'orchard-demo-midnight',
      description: 'Demo project for local development',
      createdBy: user.id,
      ownerId: user.id
    }
  });

  console.log('✅ Created project: Midnight (namespace: orchard-demo-midnight)');

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: {
        projectId: project.id,
        userId: user.id
      }
    },
    update: {},
    create: {
      projectId: project.id,
      userId: user.id,
      roleId: adminRole.id,
      addedBy: user.id
    }
  });

  console.log('✅ Added user to project as admin');

  await prisma.environment.upsert({
    where: {
      projectId_slug: {
        projectId: project.id,
        slug: 'production'
      }
    },
    update: {},
    create: {
      projectId: project.id,
      name: 'Production',
      slug: 'production',
      namespace: project.namespace,
      isDefault: true,
      isProduction: true
    }
  });

  console.log('✅ Created environment: Production');

  console.log('🌱 Seed completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
