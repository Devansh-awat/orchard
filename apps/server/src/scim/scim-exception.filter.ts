import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';

// Renders every error thrown under the SCIM routes as an RFC 7644 error
// envelope with the application/scim+json content type, so IdPs get a parseable
// body and the right status code instead of Nest's default error shape.
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ScimExceptionFilter');

  catch(exception: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    let status = 500;
    let scimType: string | undefined;
    let detail = 'Internal server error';

    if (exception && typeof exception.status === 'number' && exception.name === 'SCIMError') {
      status = exception.status;
      scimType = exception.scimType ?? undefined;
      detail = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse() as any;
      detail = typeof r === 'string' ? r : r?.detail ?? r?.message ?? exception.message;
    } else if (exception instanceof Error) {
      detail = exception.message;
      this.logger.error(`Unhandled SCIM error: ${exception.stack ?? exception.message}`);
    }

    res.status(status).setHeader('Content-Type', 'application/scim+json');
    res.json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: String(status),
      ...(scimType ? { scimType } : {}),
      detail,
    });
  }
}
