import { Prisma, PrismaClient } from '@prisma/client';

/*
 * MongoDB stores an unset optional field as *missing*, and Prisma's `{ field: null }` filter only
 * matches an explicit null (missing needs `isSet: false`). The app's queries were written for
 * Postgres (`revokedAt: null`, `parentId: null`, `consumedAt: null`, ...), so every create writes
 * an explicit null for each optional field the caller left out. That keeps `null` / `not: null`
 * filters meaning the same thing they did on Postgres. scripts/mongo-indexes.ts backfills
 * documents written before this existed.
 */

const models = Prisma.dmmf.datamodel.models;
const modelByName = new Map(models.map((m) => [m.name, m]));

/** Optional, non-list scalar/enum fields without a default, per model. */
export const NULLABLE_FIELDS: Record<string, string[]> = Object.fromEntries(
  models.map((m) => [
    m.name,
    m.fields.filter((f) => (f.kind === 'scalar' || f.kind === 'enum') && !f.isRequired && !f.isList && !f.hasDefaultValue).map((f) => f.name),
  ]),
);

type Data = Record<string, unknown>;
const isObj = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const each = (v: unknown, fn: (d: Data) => void) => (Array.isArray(v) ? v.forEach((d) => isObj(d) && fn(d)) : isObj(v) && fn(v));

function fillCreate(modelName: string, data: unknown) {
  each(data, (d) => {
    const model = modelByName.get(modelName);
    if (!model) return;
    for (const name of NULLABLE_FIELDS[modelName]) {
      // Relation scalars (e.g. parentId) can also be set through the relation field (parent: { connect }).
      const viaRelation = model.fields.some((r) => r.kind === 'object' && r.relationFromFields?.includes(name) && d[r.name] !== undefined);
      if (d[name] === undefined && !viaRelation) d[name] = null;
    }
    fillNested(modelName, d);
  });
}

/** Nested writes inside create/update data: { create }, { createMany: { data } }, { connectOrCreate }, { upsert }. */
function fillNested(modelName: string, data: Data) {
  for (const field of modelByName.get(modelName)?.fields ?? []) {
    const rel = data[field.name];
    if (field.kind !== 'object' || !isObj(rel)) continue;
    const target = field.type;
    if (rel.create) fillCreate(target, rel.create);
    if (isObj(rel.createMany)) fillCreate(target, rel.createMany.data);
    each(rel.connectOrCreate, (c) => fillCreate(target, c.create));
    each(rel.upsert, (u) => {
      fillCreate(target, u.create);
      if (isObj(u.update)) fillNested(target, u.update);
    });
    each(rel.update, (u) => isObj(u.data) ? fillNested(target, u.data) : fillNested(target, u));
  }
}

function extendWithExplicitNulls(client: PrismaClient) {
  return client.$extends({
    name: 'explicit-nulls',
    query: {
      $allModels: {
        create({ model, args, query }) {
          fillCreate(model, args.data);
          return query(args);
        },
        createMany({ model, args, query }) {
          fillCreate(model, args.data);
          return query(args);
        },
        upsert({ model, args, query }) {
          fillCreate(model, args.create);
          if (isObj(args.update)) fillNested(model, args.update as Data);
          return query(args);
        },
        update({ model, args, query }) {
          if (isObj(args.data)) fillNested(model, args.data as Data);
          return query(args);
        },
      },
    },
  });
}

export const prisma = extendWithExplicitNulls(new PrismaClient());

/** MongoDB aborts a transaction on a write conflict (P2034) instead of waiting; true for those. */
export function isWriteConflict(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

/** Transaction client of the extended client (use instead of Prisma.TransactionClient). */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
/** Either the client or a transaction client. */
export type Db = Tx | typeof prisma;

/**
 * Runs an interactive transaction, retrying on write conflicts with exponential backoff + full jitter
 * (MongoDB aborts the loser immediately rather than queueing it like a Postgres row lock would).
 */
export async function transactionWithRetry<T>(fn: (tx: Tx) => Promise<T>, maxAttempts = 10): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn);
    } catch (err) {
      if (!isWriteConflict(err) || attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * Math.min(1000, 25 * 2 ** attempt)));
    }
  }
}
