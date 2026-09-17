import { PrismaService } from '../prisma/prisma.service';

export interface NamespaceScope {
  projectId: string;
  organizationId: string;
  environmentId: string | null;
}

/**
 * A namespace belongs to a project two ways: it is either the project's own
 * namespace, or one owned by one of its environments. The default environment
 * shares the project's namespace; every other one gets a suffixed namespace of
 * its own, so resolving against Project.namespace alone makes every resource
 * outside the default environment look like it belongs to nobody — pod logs,
 * exec and the shell all 404 on it.
 */
export async function resolveNamespaceScope(
  prisma: PrismaService,
  namespace: string | undefined | null
): Promise<NamespaceScope | null> {
  if (!namespace) return null;
  const [project, environment] = await Promise.all([
    prisma.project.findFirst({
      where: { namespace },
      select: { id: true, organizationId: true }
    }),
    prisma.environment.findUnique({
      where: { namespace },
      select: { id: true, projectId: true, project: { select: { organizationId: true } } }
    })
  ]);
  if (project) {
    return {
      projectId: project.id,
      organizationId: project.organizationId,
      environmentId: environment?.projectId === project.id ? environment.id : null
    };
  }
  if (environment) {
    return {
      projectId: environment.projectId,
      organizationId: environment.project.organizationId,
      environmentId: environment.id
    };
  }
  return null;
}
