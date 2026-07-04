import { Controller, Post, Body, Request, Res, Logger } from '@nestjs/common';
import { Response } from 'express';
import { Auth, RequireScope } from '../auth/decorators';
import { AiChatService } from './ai-chat.service';

interface ChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
}

@Auth()
@Controller('ai')
export class AiChatController {
  private readonly logger = new Logger(AiChatController.name);

  constructor(private readonly aiChatService: AiChatService) {}

  @Post('chat')
  @RequireScope('read')
  async chat(@Body() body: ChatRequest, @Request() req, @Res() res: Response) {
    const user = req.user;

    // Extract the raw session token so the AI service can make internal API calls
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.session_token;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const write = (data: Record<string, any>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const chunk of this.aiChatService.streamChat(body.messages, {
        sub: user.sub,
        email: user.email,
        hackClubId: user.hackClubId,
        sessionId: user.sessionId,
        token,
      })) {
        const trimmed = chunk.trim();
        if (trimmed) {
          res.write(`data: ${trimmed}\n\n`);
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`AI chat stream error: ${msg}`);
      write({ type: 'error', error: msg });
    }

    write({ type: 'done' });
    res.end();
  }
}
