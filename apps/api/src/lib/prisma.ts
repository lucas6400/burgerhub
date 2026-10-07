import { Prisma, PrismaClient } from "@prisma/client";

/**
 * Cliente do banco com proteção contra falha passageira de conexão. O Neon "dorme" quando fica ocioso e leva alguns
 * segundos pra acordar, e o painel consulta o banco várias vezes por segundo: já deu "Can't reach database server" e
 * "Timed out fetching a new connection from the connection pool" no meio do atendimento (mensagem de cliente sem
 * resposta). Três defesas: (1) parâmetros de conexão mais folgados, (2) nova tentativa automática em erro de conexão,
 * (3) nada de repetir escrita que pode já ter sido executada.
 */

const CONNECTION_LIMIT = 15; // o padrão do Prisma (~5 em serverless) esgota com o painel aberto + bot + avisos
const CONNECT_TIMEOUT_S = 15; // dá tempo do Neon acordar (o padrão é 5s)
const POOL_TIMEOUT_S = 15; // espera por uma conexão livre do pool (o padrão é 10s)
const RETRY_DELAYS_MS = [400, 1_200];

/** Acrescenta à URL os parâmetros de pool que ela ainda não tem — respeita o que já estiver definido na variável. */
export function withPoolParams(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const set = (key: string, value: string) => {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    };
    set("connection_limit", String(CONNECTION_LIMIT));
    set("connect_timeout", String(CONNECT_TIMEOUT_S));
    set("pool_timeout", String(POOL_TIMEOUT_S));
    // Pooler do Neon = pgbouncer: o Prisma precisa saber (sem prepared statements) pra não dar erro intermitente.
    if (url.hostname.includes("-pooler")) set("pgbouncer", "true");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/** Erros de conexão onde a consulta NÃO chegou a executar — seguro repetir até escrita. */
const NOT_EXECUTED_CODES = new Set(["P1001", "P1002", "P2024"]);
/** Erros em que a consulta pode ter executado antes da queda — só leitura repete. */
const MAYBE_EXECUTED_CODES = new Set(["P1008", "P1017"]);

function errorCode(err: unknown): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code;
  if (err instanceof Prisma.PrismaClientInitializationError) return err.errorCode ?? "P1001";
  return null;
}

const isRead = (operation: string) => /^(find|count|aggregate|groupBy)/.test(operation) || operation === "$queryRaw" || operation === "$queryRawUnsafe";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withRetry<T>(operation: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = errorCode(err);
      const retryable = code !== null && (NOT_EXECUTED_CODES.has(code) || (isRead(operation) && MAYBE_EXECUTED_CODES.has(code)));
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      console.warn(`[prisma] ${code} em ${operation} — nova tentativa ${attempt + 1}/${RETRY_DELAYS_MS.length}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function createPrismaClient(databaseUrl: string | undefined = process.env.DATABASE_URL) {
  const base = new PrismaClient({ datasourceUrl: withPoolParams(databaseUrl) });
  return base.$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        return withRetry(operation, () => query(args));
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;
/** Cliente recebido dentro de `prisma.$transaction(async (tx) => …)` — o tipo do Prisma original não serve pro cliente estendido. */
export type DbTransaction = Parameters<Parameters<ExtendedPrismaClient["$transaction"]>[0]>[0];

// Em serverless (Vercel), cada invocação pode reexecutar este módulo — sem o
// cache em globalThis, cada requisição criaria um novo PrismaClient e uma
// nova conexão, esgotando o pool do banco rapidamente entre invocações "quentes".
const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
