import { Prisma } from '@prisma/client';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid request', code: 'VALIDATION', details: err.flatten() });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  // MongoDB: an id that isn't a valid ObjectId can't match anything — treat it like a missing record.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2023' && /ObjectID/i.test(err.message)) {
    return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong', code: 'INTERNAL' });
}

// BigInt isn't JSON-serializable by default (file sizes).
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};
