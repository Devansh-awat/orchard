import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

export const EXCEPTION_HEADER = 'x-iso-exception';

@Catch()
export class RecordingExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (!(exception instanceof HttpException)) {
      const response = host.switchToHttp().getResponse();
      const error = exception as Error;
      const frames = String(error?.stack ?? '')
        .split('\n')
        .slice(1, 4)
        .map((line) =>
          line
            .trim()
            .replace(/^at\s+/, '')
            .replace(/\(?\/.*\/(src|node_modules)\//, '(')
        )
        .join(' < ');
      const detail = `${error?.name ?? 'Error'}: ${String(error?.message ?? error).replace(/\s+/g, ' ')} @ ${frames}`;
      if (!response.headersSent) {
        response.setHeader(EXCEPTION_HEADER, encodeURIComponent(detail.slice(0, 400)));
      }
    }
    super.catch(exception, host);
  }
}
