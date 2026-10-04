import * as z from "zod/v4";

/**
 * Regras de refrigerante da loja (TenantSettings.sodaRules): quais marcas existem em cada tamanho e
 * quanto a marca "especial" soma no combo. Sem essa configuração o bot segue a regra antiga (nunca
 * promete marca — a loja manda o que tiver no estoque).
 */

export type SodaSize = "lata" | "1L" | "2L";

const SodaRulesSchema = z.object({
  /** Marca que vem no combo quando o cliente não escolhe. */
  defaultBrand: z.string().min(1),
  sizes: z.array(
    z.object({
      size: z.enum(["lata", "1L", "2L"]),
      brands: z.array(z.string().min(1)).min(1),
      /** Acréscimo no preço do COMBO por unidade, por marca (centavos). Marca fora do mapa não soma nada. */
      surchargeCents: z.record(z.string(), z.number().int().min(0)).default({}),
    }),
  ),
});

export type SodaRules = z.infer<typeof SodaRulesSchema>;

export function parseSodaRules(raw: unknown): SodaRules | null {
  if (!raw) return null;
  const parsed = SodaRulesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** "coca-cola", "Coca", "coquinha" → "Coca"; devolve null se não bate com nenhuma marca da loja. */
export function canonicalBrand(rules: SodaRules, text: string): string | null {
  const t = stripAccents(text.toLowerCase());
  const known = new Set(rules.sizes.flatMap((s) => s.brands));
  for (const brand of known) {
    const b = stripAccents(brand.toLowerCase());
    if (t.includes(b)) return brand;
    if (b === "coca" && /\bcoca|coquinha|coke/.test(t)) return brand;
    if (b === "guarana" && /\bguara/.test(t)) return brand;
  }
  return null;
}

export function sizeRule(rules: SodaRules, size: SodaSize) {
  return rules.sizes.find((s) => s.size === size) ?? null;
}

const SIZE_PATTERNS: [SodaSize, RegExp][] = [
  ["lata", /\blata\b/i],
  ["1L", /(?<![\d.,])1\s*(l\b|litro)/i],
  ["2L", /(?<![\d.,])2\s*(l\b|litros?)/i],
];

export function sizeOfText(text: string): SodaSize | null {
  return SIZE_PATTERNS.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Tamanho do refri embutido num combo ("2 X Tudo + refrigerante 1L" → "1L"); null se o produto não é combo com refri. */
export function comboSodaSize(productName: string): SodaSize | null {
  const afterPlus = productName.split("+").slice(1).join("+");
  if (!/refri|coca|guaran|pepsi|bebida/i.test(afterPlus)) return null;
  return sizeOfText(afterPlus);
}

export const SIZE_LABEL: Record<SodaSize, string> = { lata: "Lata", "1L": "1L", "2L": "2L" };

export interface BeverageProduct {
  name: string;
  priceCents: number;
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Produto de BEBIDAS do cardápio que vende essa marca nesse tamanho (o específico da marca, senão o genérico do tamanho). */
export function standaloneProduct(rules: SodaRules, beverages: BeverageProduct[], size: SodaSize, brand: string): BeverageProduct | null {
  const ofSize = beverages.filter((p) => sizeOfText(p.name) === size);
  const brandInName = (name: string) => canonicalBrand(rules, name);
  return ofSize.find((p) => brandInName(p.name) === brand) ?? ofSize.find((p) => brandInName(p.name) === null) ?? null;
}

/** Bloco de prompt com as regras de refrigerante da loja, montado a partir da configuração e do cardápio real. */
export function buildSodaPolicyText(rules: SodaRules, beverages: BeverageProduct[]): string {
  const lines: string[] = [];
  for (const s of rules.sizes) {
    const options = s.brands.map((brand) => {
      const product = standaloneProduct(rules, beverages, s.size, brand);
      return product
        ? `${brand} — produto "${product.name}" (${brl(product.priceCents)})${canonicalBrand(rules, product.name) ? "" : ", marca em notes"}`
        : `${brand} (sem produto avulso no cardápio)`;
    });
    lines.push(`  • ${SIZE_LABEL[s.size]}: ${options.join("; ")}`);
  }
  const surcharges = rules.sizes
    .flatMap((s) => Object.entries(s.surchargeCents).filter(([, cents]) => cents > 0).map(([brand, cents]) => `${brand} no combo de ${SIZE_LABEL[s.size]} soma ${brl(cents)}`))
    .join("; ");
  return `REFRIGERANTES (regras da loja — valem acima de qualquer outra regra sobre marca de refri):
Opções por tamanho, com o produto do cardápio e o preço avulso:
${lines.join("\n")}
- Marca/tamanho FORA dessa lista não existe (ex.: não existe Pepsi 1L) — nunca ofereça nem aceite; diga as opções que existem.
- Quando o cliente quiser TROCAR o refri do combo ou ADICIONAR um refri avulso: diga as opções do tamanho que interessa (se não souber o tamanho, os três) com o PREÇO AVULSO de cada e pergunte qual prefere. Só fale disso quando ele pedir; não pergunte marca de quem não falou de refri.
- AVULSO: update_cart_item com o produto indicado acima (e a marca em notes quando indicado). Nunca ofereça marca que não está na lista do tamanho.
- TROCAR O REFRI DO COMBO: use set_combo_soda (nunca update_cart_item nem notes). O combo vem com ${rules.defaultBrand} por padrão. ${surcharges ? `${surcharges} (o sistema calcula e a ferramenta devolve o novo valor) — diga ao cliente o valor novo do combo. Marcas sem acréscimo listado não mudam o preço.` : "Trocar a marca não muda o preço."}
- Se o cliente não falar de refri, o combo sai com ${rules.defaultBrand}.`;
}
