/**
 * Garante o formato internacional (55 + DDD + número) que o Evolution API e a
 * Cloud API da Meta exigem pra entregar mensagem de verdade — números vindos
 * do cardápio web (o cliente digita só "DDD + número", sem o código do país)
 * chegam sem o "55" e a mensagem falha silenciosamente sem isso. Só ajusta o
 * valor enviado pro provedor — nunca o `Customer.phone` salvo no banco, pra
 * não arriscar duplicar cadastro de cliente que já existe sem o prefixo.
 */
export function normalizeBrazilPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

/**
 * Número pra LINK clicável de WhatsApp (ticket pro dono, pro entregador): sem o 9º dígito o
 * link às vezes não abre a conversa certa, e a equipe acaba tendo que copiar e redigitar na mão.
 * Cliente digitado no cardápio, ou já cadastrado de antes, às vezes fica sem esse dígito — insere
 * de volta quando reconhece o padrão (DDD + 8 dígitos começando em 6-9 = celular pré-2012 salvo
 * sem o 9 extra). Nunca mexe em número de telefone fixo.
 */
export function brazilCellphoneLink(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
  if (digits.length === 10 && /^\d{2}[6-9]/.test(digits)) {
    digits = `${digits.slice(0, 2)}9${digits.slice(2)}`;
  }
  return `https://wa.me/55${digits}`;
}
