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

type BusinessHourLike = { weekday: number; openTime: string; closeTime: string; closed?: boolean };
type OpenInput = { isOpenOverride?: boolean | null; isOpenOverrideAt?: Date | null; businessHours: BusinessHourLike[] };

const DAY_NAMES = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MS_HOUR = 3_600_000;

export interface NextOpening {
  /** Instante real da abertura. */
  at: Date;
  weekday: number;
  /** Quantos dias à frente de "hoje" (0 = hoje, 1 = amanhã). */
  daysAhead: number;
  openTime: string;
  /** "dd/mm" no horário da loja. */
  dateLabel: string;
}

/** Primeira abertura do horário cadastrado DEPOIS do instante dado (dias marcados como fechados são pulados). */
export function nextOpeningAfter(after: Date, hours: BusinessHourLike[]): NextOpening | null {
  // Offset fixo (Brasil sem horário de verão): "relógio da loja" = UTC − 3h, tratado como se fosse UTC.
  const localAfter = after.getTime() - STORE_UTC_OFFSET_HOURS * MS_HOUR;
  const localNow = Date.now() - STORE_UTC_OFFSET_HOURS * MS_HOUR;
  const base = new Date(localAfter);
  const todayStart = Date.UTC(new Date(localNow).getUTCFullYear(), new Date(localNow).getUTCMonth(), new Date(localNow).getUTCDate());
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset));
    const h = hours.find((x) => x.weekday === day.getUTCDay() && !x.closed);
    if (!h) continue;
    const [hh, mm] = h.openTime.split(":").map(Number);
    const localOpen = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm);
    if (localOpen <= localAfter) continue;
    return {
      at: new Date(localOpen + STORE_UTC_OFFSET_HOURS * MS_HOUR),
      weekday: day.getUTCDay(),
      daysAhead: Math.round((Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - todayStart) / (24 * MS_HOUR)),
      openTime: h.openTime,
      dateLabel: `${String(day.getUTCDate()).padStart(2, "0")}/${String(day.getUTCMonth() + 1).padStart(2, "0")}`,
    };
  }
  return null;
}

/** "amanhã, terça-feira (13/10), às 18:30" / "hoje, segunda-feira (12/10), às 18:30" / "sexta-feira (16/10), às 18:30". */
export function describeOpening(op: NextOpening): string {
  const rel = op.daysAhead === 0 ? "hoje, " : op.daysAhead === 1 ? "amanhã, " : "";
  return `${rel}${DAY_NAMES[op.weekday]} (${op.dateLabel}), às ${op.openTime}`;
}

/**
 * O "Fechada" forçado do painel vale só até a próxima abertura do horário cadastrado — senão a loja ficava fechada
 * pra sempre se o dono esquecesse de voltar pro "Horário normal". Sem a data do clique (linha antiga), não expira.
 */
function effectiveOverride(input: OpenInput): boolean | null {
  const { isOpenOverride, isOpenOverrideAt } = input;
  if (isOpenOverride !== false || !isOpenOverrideAt) return isOpenOverride ?? null;
  const reopen = nextOpeningAfter(isOpenOverrideAt, input.businessHours);
  return reopen && reopen.at.getTime() <= Date.now() ? null : false;
}

/** Quando a loja volta a receber pedidos depois de um fechamento forçado (null = não há data prevista). */
export function reopeningAfterOverride(input: OpenInput): NextOpening | null {
  if (effectiveOverride(input) !== false) return null;
  return nextOpeningAfter(input.isOpenOverrideAt ?? new Date(), input.businessHours);
}

/** Fechamento igual ou antes da abertura ("18:30–00:00", "18:30–02:00") = fecha depois da meia-noite. */
const crossesMidnight = (h: BusinessHourLike): boolean => h.closeTime <= h.openTime;

function withinHoursNow(hours: BusinessHourLike[]): boolean {
  const { weekday, hhmm } = nowInStoreTimezone();
  const yesterday = (weekday + 6) % 7;
  return hours.some((h) => {
    if (h.closed) return false;
    if (h.weekday === weekday) return crossesMidnight(h) ? hhmm >= h.openTime : h.openTime <= hhmm && hhmm <= h.closeTime;
    // Madrugada: o expediente de ontem que passou da meia-noite (ex.: 18:30–02:00) ainda está valendo.
    return h.weekday === yesterday && crossesMidnight(h) && hhmm <= h.closeTime;
  });
}

/** Se a loja está aberta agora — override manual do lojista tem prioridade sobre o horário cadastrado. */
export function isStoreOpenNow(input: OpenInput): boolean {
  const override = effectiveOverride(input);
  if (override != null) return override;
  return withinHoursNow(input.businessHours);
}

/**
 * Loja FECHADA DE PROPÓSITO (não só fora do horário): botão "Fechada" do painel ou dia marcado como fechado nos
 * horários. Aí o bot não anota nem agenda pedido. Fora do horário num dia de funcionamento continua valendo o
 * agendamento ("anoto agora e preparamos quando abrir").
 */
export function isStoreBlockingOrders(input: OpenInput): boolean {
  const override = effectiveOverride(input);
  if (override === true) return false;
  if (override === false) return true;
  const { weekday } = nowInStoreTimezone();
  return !input.businessHours.some((h) => h.weekday === weekday && !h.closed);
}

/** Minutos até a loja fechar HOJE (pelo horário cadastrado) — null se já fechada ou sem horário hoje. */
export function minutesUntilCloseToday(
  businessHours: { weekday: number; openTime: string; closeTime: string; closed?: boolean }[],
): number | null {
  const { weekday, hhmm } = nowInStoreTimezone();
  const today = businessHours.find((h) => h.weekday === weekday && !h.closed);
  if (!today || (!crossesMidnight(today) && hhmm > today.closeTime)) return null;
  const [nowH, nowM] = hhmm.split(":").map(Number);
  const [closeH, closeM] = today.closeTime.split(":").map(Number);
  // Fecha depois da meia-noite: conta até o fim do dia mais o que passa dele.
  return closeH * 60 + closeM + (crossesMidnight(today) ? 24 * 60 : 0) - (nowH * 60 + nowM);
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
