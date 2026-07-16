import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export const THREAD_STATUSES = ['open', 'planned', 'in-progress', 'done', 'declined'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

const DEFAULT_CATEGORIES = [
  { slug: 'announcements', name: 'Announcements', emoji: '📣', description: 'News from the Orchard team', sortOrder: 0 },
  { slug: 'bugs', name: 'Bugs', emoji: '🐛', description: 'Something in the orchard is wormy', sortOrder: 1 },
  { slug: 'features', name: 'Feature requests', emoji: '🌱', description: 'Plant an idea, watch it grow', sortOrder: 2 },
  { slug: 'help', name: 'Help', emoji: '💬', description: 'Stuck? Ask the grove', sortOrder: 3 },
  { slug: 'showcase', name: 'Showcase', emoji: '🧺', description: 'Show off what you harvested', sortOrder: 4 },
];

const AUTHOR_SELECT = { id: true, username: true, imageUrl: true } as const;

@Injectable()
export class ForumService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    for (const cat of DEFAULT_CATEGORIES) {
      await this.prisma.forumCategory
        .upsert({ where: { slug: cat.slug }, update: {}, create: cat })
        .catch(() => {});
    }
  }

  async listCategories() {
    const cats = await this.prisma.forumCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { threads: true } } },
    });
    return cats.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      emoji: c.emoji,
      description: c.description,
      threadCount: c._count.threads,
    }));
  }

  async listThreads(opts: { categorySlug?: string; sort?: string; userId: string }) {
    const where = opts.categorySlug ? { category: { slug: opts.categorySlug } } : {};
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
        votes: { where: { userId: opts.userId }, select: { userId: true } },
      },
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
          include: { author: { select: AUTHOR_SELECT } },
        },
      },
    });
    if (!t) throw new NotFoundException('Thread not found');
    return {
      ...this.shapeThread(t),
      body: t.body,
      replies: t.replies.map((r) => ({
        id: r.id,
        body: r.body,
        createdAt: r.createdAt,
        author: r.author,
      })),
    };
  }

  async createThread(userId: string, body: { categorySlug: string; title: string; body: string }) {
    const title = body.title?.trim() ?? '';
    const text = body.body?.trim() ?? '';
    if (title.length < 4 || title.length > 200) {
      throw new BadRequestException('Title must be between 4 and 200 characters');
    }
    if (text.length < 1 || text.length > 10000) {
      throw new BadRequestException('Body must be between 1 and 10000 characters');
    }
    const category = await this.prisma.forumCategory.findUnique({
      where: { slug: body.categorySlug },
    });
    if (!category) throw new BadRequestException('Unknown category');
    const created = await this.prisma.forumThread.create({
      data: { categoryId: category.id, authorId: userId, title, body: text },
    });
    return this.getThread(created.id, userId);
  }

  async createReply(userId: string, threadId: string, text: string) {
    const body = text?.trim() ?? '';
    if (body.length < 1 || body.length > 10000) {
      throw new BadRequestException('Reply must be between 1 and 10000 characters');
    }
    const thread = await this.prisma.forumThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Thread not found');
    if (thread.locked) throw new BadRequestException('Thread is locked');
    const reply = await this.prisma.forumReply.create({
      data: { threadId, authorId: userId, body },
      include: { author: { select: AUTHOR_SELECT } },
    });
    await this.prisma.forumThread.update({
      where: { id: threadId },
      data: { lastActivityAt: new Date() },
    });
    return { id: reply.id, body: reply.body, createdAt: reply.createdAt, author: reply.author };
  }

  async setVote(userId: string, threadId: string, on: boolean) {
    const thread = await this.prisma.forumThread.findUnique({ where: { id: threadId } });
    if (!thread) throw new NotFoundException('Thread not found');
    if (on) {
      await this.prisma.forumVote
        .create({ data: { threadId, userId } })
        .catch(() => {});
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
      title: t.title,
      snippet: String(t.body).slice(0, 200),
      status: t.status,
      pinned: t.pinned,
      locked: t.locked,
      createdAt: t.createdAt,
      lastActivityAt: t.lastActivityAt,
      author: t.author,
      category: t.category,
      replyCount: t._count.replies,
      votes: t._count.votes,
      myVote: t.votes.length > 0,
    };
  }
}
