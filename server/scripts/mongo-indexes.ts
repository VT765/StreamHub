/*
 * Run after `prisma db push` (npm run db:push does both). Idempotent.
 *
 * 1. Backfills explicit nulls for optional fields that are missing on existing documents, so
 *    `{ field: null }` filters match them (see src/lib/prisma.ts).
 * 2. Creates unique indexes that ignore nulls for optional unique fields. Postgres allows many NULLs
 *    in a unique column; a plain MongoDB unique index treats every null/missing value as equal.
 */
import { NULLABLE_FIELDS, prisma } from '../src/lib/prisma.js';

const PARTIAL_UNIQUE: { collection: string; field: string }[] = [
  { collection: 'Payment', field: 'razorpayPaymentId' },
  { collection: 'Payment', field: 'invoiceNumber' },
];

async function main() {
  let backfilled = 0;
  for (const [collection, fields] of Object.entries(NULLABLE_FIELDS)) {
    if (!fields.length) continue;
    const res = (await prisma.$runCommandRaw({
      update: collection,
      updates: fields.map((f) => ({ q: { [f]: { $exists: false } }, u: { $set: { [f]: null } }, multi: true })),
    })) as { nModified?: number };
    backfilled += res.nModified ?? 0;
  }
  console.log(`Backfilled explicit nulls (${backfilled} field updates).`);

  for (const { collection, field } of PARTIAL_UNIQUE) {
    const name = `${collection}_${field}_key`;
    // `$gte: ''` = "is a string" (comparisons are type-bracketed); `$type` is reserved in Prisma's raw JSON.
    const create = () =>
      prisma.$runCommandRaw({
        createIndexes: collection,
        indexes: [{ key: { [field]: 1 }, name, unique: true, partialFilterExpression: { [field]: { $gte: '' } } }],
      });
    try {
      await create(); // no-op if this exact index already exists
    } catch (err) {
      // Same name, different options (e.g. an old plain unique index): replace it.
      if (!/IndexOptionsConflict|IndexKeySpecsConflict|already exists with different options/i.test(String(err))) throw err;
      await prisma.$runCommandRaw({ dropIndexes: collection, index: name });
      await create();
    }
  }
  console.log(`Unique-when-set indexes ensured: ${PARTIAL_UNIQUE.map((p) => `${p.collection}.${p.field}`).join(', ')}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
