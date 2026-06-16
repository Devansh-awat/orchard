import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting seed...');

  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: {
      name: 'admin',
      description: 'Full administrative access to workspace',
    },
  });

  const memberRole = await prisma.role.upsert({
    where: { name: 'member' },
    update: {},
    create: {
      name: 'member',
      description: 'Standard member access to workspace',
    },
  });

  const viewerRole = await prisma.role.upsert({
    where: { name: 'viewer' },
    update: {},
    create: {
      name: 'viewer',
      description: 'Read-only access to workspace resources',
    },
  });

  console.log('✅ Created roles: admin, member, viewer');

  const passwordHash = await bcrypt.hash('password123', 10);

  const user = await prisma.user.upsert({
    where: { email: 'admin@orchard.dev' },
    update: {},
    create: {
      email: 'admin@orchard.dev',
      username: 'orchard-admin',
      passwordHash,
      firstName: 'Orchard',
      lastName: 'Admin',
    },
  });

  console.log('✅ Created user: admin@orchard.dev');

  const organization = await prisma.organization.upsert({
    where: { slug: 'orchard-demo' },
    update: {},
    create: {
      name: 'Orchard Demo',
      slug: 'orchard-demo',
      description: 'Orchard Demo organization',
      createdBy: user.id,
    },
  });

  console.log('✅ Created organization: Orchard Demo');

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: organization.id,
        userId: user.id,
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      userId: user.id,
      role: 'owner',
      addedBy: user.id,
    },
  });

  console.log('✅ Added user to organization as owner');

  const workspace = await prisma.workspace.upsert({
    where: {
      organizationId_slug: {
        organizationId: organization.id,
        slug: 'midnight',
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      name: 'Midnight',
      slug: 'midnight',
      description: 'Midnight workspace for testing',
      createdBy: user.id,
    },
  });

  console.log('✅ Created workspace: Midnight');

  await prisma.workspaceMember.upsert({
    where: {
      workspaceId_userId_roleId: {
        workspaceId: workspace.id,
        userId: user.id,
        roleId: adminRole.id,
      },
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      roleId: adminRole.id,
      addedBy: user.id,
    },
  });

  console.log('✅ Added user to workspace as admin');

  const project = await prisma.project.upsert({
    where: {
      workspaceId_slug: {
        workspaceId: workspace.id,
        slug: 'midnight-staging',
      },
    },
    update: {},
    create: {
      workspaceId: workspace.id,
      name: 'Midnight Staging',
      slug: 'midnight-staging',
      namespace: 'midnight-staging',
      description: 'Staging environment for Midnight',
      createdBy: user.id,
    },
  });

  console.log('✅ Created project: Midnight Staging (namespace: midnight-staging)');

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

