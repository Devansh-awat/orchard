import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../organizations/storage.service';
import { objectStorage } from '../instance-config/object-storage';

export const THREAD_STATUSES = [
  'open',
  'acknowledged',
  'will-fix',
  'in-progress',
  'fixed',
  'wont-fix'
] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const THREAD_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type ThreadPriority = (typeof THREAD_PRIORITIES)[number];

const MAX_IMAGES = 4;

// Only URLs our own upload endpoint can produce are stored. Anything else
// would let a crafted create/delete cycle feed arbitrary same-bucket URLs
// into storage.deleteFile, deleting other users' objects (e.g. avatars).
function forumImageBase(): string {
  const publicUrl = objectStorage().publicUrl ?? '';
  return `${publicUrl}/forum/`;
}

function cleanImages(images: unknown): string[] {
  if (!Array.isArray(images)) return [];
  const base = forumImageBase();
  return images
    .filter((u): u is string => typeof u === 'string' && u.startsWith(base) && u.length <= 500)
    .slice(0, MAX_IMAGES);
}

const DEFAULT_CATEGORIES = [
  {
    slug: 'bugs',
    name: 'Bugs',
    emoji: '',
    description: 'Something is broken or behaving wrong',
    sortOrder: 0
  },
  {
    slug: 'features',
    name: 'Feature requests',
    emoji: '',
    description: 'Something Orchard should do',
    sortOrder: 1
  }
];

export const THREAD_SCOPES = ['platform', 'cli', 'mcp', 'other'] as const;
export type ThreadScope = (typeof THREAD_SCOPES)[number];

const AUTHOR_SELECT = { id: true, username: true, imageUrl: true } as const;

@Injectable()
export class ForumService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService
  ) {}

  async onModuleInit() {
    if (process.env.GROVE_ENABLED !== 'true') return;
    for (const cat of DEFAULT_CATEGORIES) {
      await this.prisma.forumCategory
        .upsert({ where: { slug: cat.slug }, update: {}, create: cat })
        .catch(() => {});
    }
  }

  async listCategories() {
    const cats = await this.prisma.forumCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { threads: true } } }
    });
    return cats.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      emoji: c.emoji,
      description: c.description,
      threadCount: c._count.threads
    }));
  }

  async listThreads(opts: {
    categorySlug?: string;
    status?: string;
    scope?: string;
    sort?: string;
    userId: string;
  }) {
    const where = {
      ...(opts.categorySlug ? { category: { slug: opts.categorySlug } } : {}),
      ...(opts.status && THREAD_STATUSES.includes(opts.status as ThreadStatus)
        ? { status: opts.status }
        : {}),
      ...(opts.scope && THREAD_SCOPES.includes(opts.scope as ThreadScope)
        ? { scope: opts.scope }
        : {})
    };
    const threads = await this.prisma.forumThread.findMany({
      where,
      orderBy:
        opts.sort === 'top'
          ? [{ pinned: 'desc' }, { votes: { _count: 'desc' } }, { lastActivityAt: 'desc' }]
          : [{ pinned: 'desc' }, { lastActivityAt: 'desc' }],
      take: 100,
      include: {
        author: { select: AUTHOR_SELECT },
        category: { select: { slug: true, name: true, emoji: true } },
        _count: { select: { replies: true, votes: true } },
        votes: { where: { userId: opts.userId }, select: { userId: true } }
      }
    });
    return threads.map((t) => this.shapeThread(t));
  }

  async getThread(id: string, userId: string) {
    const t = await this.prisma.forumThread.findUnique({
      where: { id },
      include: {
        author: { select: AUTHOR_SELECT },
        category: { select: { slug: true, name: true, emoji: true } },
        _count: { select: { replies: true, votes: true } },
        votes: { where: { userId }, select: { userId: true } },
        replies: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: AUTHOR_SELECT } }
        }
      }
    });
    if (!t) throw new NotFoundException('Thread not found');
    return {
      ...this.shapeThread(t),
      body: t.body,
      replies: t.replies.map((r) => ({
        id: r.id,
        body: r.body,
        images: r.images,
        createdAt: r.createdAt,
        author: r.author
      }))
    };
  }

  async createThread(
    userId: string,
    body: { categorySlug: string; title: string; body: string; scope?: string; images?: string[] }
  ) {
    const title = body.title?.trim() ?? '';
    const text = body.body?.trim() ?? '';
    if (title.length < 4 || title.length > 200) {
      throw new BadRequestException('Title must be between 4 and 200 characters');
    }
    if (text.length < 1 || text.length > 10000) {
      throw new BadRequestException('Body must be between 1 and 10000 characters');
    }
    const scope = body.scope ?? 'platform';
    if (!THREAD_SCOPES.includes(scope as ThreadScope)) {
      throw new BadRequestException('Invalid scope');
    }
    const category = await this.prisma.forumCategory.findUnique({
      where: { slug: body.categorySlug }
    });
    if (!category) throw new BadRequestException('Unknown category');
    const created = await this.prisma.forumThread.create({
      data: {
        categoryId: category.id,
        authorId: userId,
        title,
        body: text,
        scope,
        images: cleanImages(body.images)
      }
    });
    return this.getThread(created.id, userId);
  }

  async createReply(userId: string, threadId: string, text: string, images?: string[]) {
    const body = text?.trim() ?? '';
    if (body.length < 1 || body.length > 10000) {
      throw new BadRequestException('Reply must be between 1 and 10000 characters');
    }
    const thread = await this.prisma.forumThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Thread not found');
    if (thread.locked) throw new BadRequestException('Thread is locked');
    const reply = await this.prisma.forumReply.create({
      data: { threadId, authorId: userId, body, images: cleanImages(images) },
      include: { author: { select: AUTHOR_SELECT } }
    });
    await this.prisma.forumThread.update({
      where: { id: threadId },
      data: { lastActivityAt: new Date() }
    });
    return {
      id: reply.id,
      body: reply.body,
      images: reply.images,
      createdAt: reply.createdAt,
      author: reply.author
    };
  }

  async deleteThread(threadId: string, userId: string, isAdmin: boolean) {
    const thread = await this.prisma.forumThread.findUnique({
      where: { id: threadId },
      select: { id: true, authorId: true, images: true, replies: { select: { images: true } } }
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (!isAdmin && thread.authorId !== userId) {
      throw new ForbiddenException('You can only delete your own posts');
    }
    const base = forumImageBase();
    const images = [...thread.images, ...thread.replies.flatMap((r) => r.images)].filter((u) =>
      u.startsWith(base)
    );
    await this.prisma.forumThread.delete({ where: { id: threadId } });
    for (const url of images) {
      void this.storage.deleteFile(url).catch(() => {});
    }
    return { deleted: true };
  }

  async deleteReply(replyId: string, userId: string, isAdmin: boolean) {
    const reply = await this.prisma.forumReply.findUnique({
      where: { id: replyId },
      select: { id: true, authorId: true, images: true }
    });
    if (!reply) throw new NotFoundException('Reply not found');
    if (!isAdmin && reply.authorId !== userId) {
      throw new ForbiddenException('You can only delete your own replies');
    }
    await this.prisma.forumReply.delete({ where: { id: replyId } });
    const base = forumImageBase();
    for (const url of reply.images.filter((u) => u.startsWith(base))) {
      void this.storage.deleteFile(url).catch(() => {});
    }
    return { deleted: true };
  }

  async setPriority(threadId: string, priority: string) {
    if (!THREAD_PRIORITIES.includes(priority as ThreadPriority)) {
      throw new BadRequestException('Invalid priority');
    }
    await this.ensureThread(threadId);
    await this.prisma.forumThread.update({ where: { id: threadId }, data: { priority } });
    return { priority };
  }

  async setVote(userId: string, threadId: string, on: boolean) {
    const thread = await this.prisma.forumThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Thread not found');
    if (on) {
      await this.prisma.forumVote.create({ data: { threadId, userId } }).catch(() => {});
    } else {
      await this.prisma.forumVote
        .delete({ where: { threadId_userId: { threadId, userId } } })
        .catch(() => {});
    }
    const votes = await this.prisma.forumVote.count({ where: { threadId } });
    return { votes, myVote: on };
  }

  async setStatus(threadId: string, status: string) {
    if (!THREAD_STATUSES.includes(status as ThreadStatus)) {
      throw new BadRequestException('Invalid status');
    }
    await this.ensureThread(threadId);
    await this.prisma.forumThread.update({ where: { id: threadId }, data: { status } });
    return { status };
  }

  async setPinned(threadId: string, pinned: boolean) {
    await this.ensureThread(threadId);
    await this.prisma.forumThread.update({ where: { id: threadId }, data: { pinned } });
    return { pinned };
  }

  async setLocked(threadId: string, locked: boolean) {
    await this.ensureThread(threadId);
    await this.prisma.forumThread.update({ where: { id: threadId }, data: { locked } });
    return { locked };
  }

  private async ensureThread(id: string) {
    const t = await this.prisma.forumThread.findUnique({ where: { id }, select: { id: true } });
    if (!t) throw new NotFoundException('Thread not found');
  }

  private shapeThread(t: any) {
    return {
      id: t.id,
      number: t.number,
      title: t.title,
      snippet: String(t.body).slice(0, 200),
      status: t.status,
      priority: t.priority,
      scope: t.scope,
      images: t.images,
      pinned: t.pinned,
      locked: t.locked,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      author: t.author,
      category: t.category,
      replyCount: t._count.replies,
      votes: t._count.votes,
      myVote: t.votes.length > 0
    };
  }
}
