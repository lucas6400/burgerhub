import * as z from "zod/v4";

/**
 * Adicionais que o bot vende em hambúrguer e combo (TenantSettings.botExtras): "bacon extra", "ovo"...
 * Não são produtos do cardápio nem adicionais do cardápio digital — ficam só no bot e entram no pedido como
 * acréscimo no preço e no nome do item ("X - Tudo (+ Bacon)"), que é o que a cozinha e o ticket mostram.
 */

const ExtrasSchema = z
  .array(z.object({ name: z.string().min(1), priceCents: z.number().int().min(0) }))
  .min(1);

export type ExtraOption = z.infer<typeof ExtrasSchema>[number];

export function parseExtras(raw: unknown): ExtraOption[] | null {
  if (!raw) return null;
  const parsed = ExtrasSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Máximo de unidades do MESMO adicional por unidade do lanche (2 de bacon extra num X-Tudo, por exemplo). */
export const MAX_EXTRA_PER_UNIT = 3;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Como o cliente escreve → o que existe no cadastro ("mussarela" → "Muçarela", "hamburguer" → "Hambúrguer Extra"). */
const ALIASES: [RegExp, string][] = [
  [/\b(mussarela|mucarela|muzzarela|mozarela|mozzarela|queijo)\b/, "mucarela"],
  [/\b(hamburguer|hamburger|burger|carne|blend)\b/, "hamburguer"],
  [/\b(linguica|linguica calabresa)\b/, "calabresa"],
  [/\b(catupiri|catupiry|catupirii)\b/, "catupiry"],
];

export function findExtra(extras: ExtraOption[], text: string): ExtraOption | null {
  let q = norm(text).replace(/\b(extra|extras|adicional|adicionais|de|do|da|com|um|uma|mais)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;
  for (const [re, to] of ALIASES) if (re.test(q)) q = q.replace(re, to);
  return (
    extras.find((e) => norm(e.name) === q) ??
    extras.find((e) => norm(e.name).includes(q)) ??
    extras.find((e) => q.includes(norm(e.name).split(" ")[0])) ??
    null
  );
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function buildExtrasPolicyText(extras: ExtraOption[]): string {
  return `ADICIONAIS (a loja vende estes extras em hambúrguer e em combo; preço POR UNIDADE do adicional):
${extras.map((e) => `  • ${e.name} — ${brl(e.priceCents)}`).join("\n")}
- Quando o cliente perguntar de adicional, ou pedir pra acrescentar algo num lanche/combo ("com bacon", "mais um ovo", "tem catupiry?"): mostre a lista com os preços (ou só o que ele perguntou) e, se ele quiser, registre com set_item_extra — informando o produto que está no carrinho, o adicional, count (quantos desse adicional cada unidade leva; 0 remove) e unit. O sistema calcula o valor: diga ao cliente o valor novo do item. NUNCA use update_cart_item nem notes pra adicional, e nunca invente adicional ou preço que não esteja nessa lista.
- Item com UMA unidade: unit null. Item com VÁRIAS unidades (ex.: 2x X-Bacon): unit é qual unidade recebe (1, 2...) e unit null só se o cliente disser que é em TODAS. "Um com bacon e outro com ovo" = duas chamadas (Bacon na unidade 1, Ovo na unidade 2). "Um deles com ovo e muçarela" = Ovo e Muçarela, os dois na unidade 1. Se o cliente pedir adicional num item de várias unidades e não ficar claro em qual, pergunte em uma frase.
- Adicional é ACRESCENTAR; tirar ingrediente é outra coisa (regra de tirar ingrediente, sem custo). "Muçarela" = mussarela.
- Só vale em hambúrguer e combo (não em bebida nem porção). Em combo, o adicional entra no combo (ex.: um bacon extra num dos lanches do combo = unit 1, e a quantidade do combo costuma ser 1).`;
}
