import { PrismaClient } from "@prisma/client";

// Em serverless (Vercel), cada invocação pode reexecutar este módulo — sem o
// cache em globalThis, cada requisição criaria um novo PrismaClient e uma
// nova conexão, esgotando o pool do banco rapidamente entre invocações "quentes".
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
