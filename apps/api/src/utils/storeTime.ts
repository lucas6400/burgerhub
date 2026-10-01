/**
 * O servidor (Vercel) roda em UTC — qualquer comparação de hora/dia "de hoje"
 * feita com Date.getHours()/getDay()/setHours() direto usa o relógio do
 * servidor, não o horário da loja. Isso já causou loja marcada como aberta/
 * fechada no horário errado e cortaria as vendas da noite (21h-23h59, horário
 * de pico) no dia seguinte nos relatórios. Todo código que precisa saber "que
 * horas são agora" ou "que dia é hoje" pro lojista deve passar por aqui.
 *
 * Brasil continental (onde ficam as hamburguerias do BurgerHub) é sempre
 * UTC-3, sem horário de verão desde 2019 — por isso o offset fixo abaixo é
 * seguro; STORE_TZ ainda é usado via Intl pra extrair a data/hora corretas
 * consultando a IANA tz database (evita reimplementar a lógica de calendário).
 */
const STORE_TZ = "America/Sao_Paulo";
const STORE_UTC_OFFSET_HOURS = 3;
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Dia da semana (0=domingo) e "HH:mm" atuais no horário da loja. */
export function nowInStoreTimezone(): { weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: STORE_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { weekday: WEEKDAY_INDEX[get("weekday")], hhmm: `${get("hour")}:${get("minute")}` };
}

/** Se a loja está aberta agora — override manual do lojista tem prioridade sobre o horário cadastrado. */
export function isStoreOpenNow(input: {
  isOpenOverride?: boolean | null;
  businessHours: { weekday: number; openTime: string; closeTime: string; closed?: boolean }[];
}): boolean {
  if (input.isOpenOverride != null) return input.isOpenOverride;
  const { weekday, hhmm } = nowInStoreTimezone();
  return input.businessHours.some(
    (h) => h.weekday === weekday && !h.closed && h.openTime <= hhmm && hhmm <= h.closeTime,
  );
}

/** Minutos até a loja fechar HOJE (pelo horário cadastrado) — null se já fechada ou sem horário hoje. */
export function minutesUntilCloseToday(
  businessHours: { weekday: number; openTime: string; closeTime: string; closed?: boolean }[],
): number | null {
  const { weekday, hhmm } = nowInStoreTimezone();
  const today = businessHours.find((h) => h.weekday === weekday && !h.closed);
  if (!today || hhmm > today.closeTime) return null;
  const [nowH, nowM] = hhmm.split(":").map(Number);
  const [closeH, closeM] = today.closeTime.split(":").map(Number);
  return closeH * 60 + closeM - (nowH * 60 + nowM);
}

/** Hora do dia (0-23) no horário da loja — pra agrupar pedidos por horário de pico. */
export function hourInStoreTimezone(date: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TZ, hour: "2-digit", hourCycle: "h23" }).format(date);
  return Number(hour);
}

/** "YYYY-MM-DD" no horário da loja — pra agrupar pedidos por dia sem cortar a última noite. */
export function dateKeyInStoreTimezone(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Meia-noite (00:00) de N dias atrás no horário da loja, como instante UTC real — pra filtros `createdAt >= `. */
export function startOfDayInStoreTimezone(daysAgoCount = 0): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day") - daysAgoCount, STORE_UTC_OFFSET_HOURS, 0, 0, 0));
}

/** Dia 1, 00:00, do mês atual no horário da loja, como instante UTC real. */
export function startOfMonthInStoreTimezone(): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, 1, STORE_UTC_OFFSET_HOURS, 0, 0, 0));
}
