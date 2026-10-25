import type { Order } from "../types";
import { api } from "./api";
import { brl, formatDateTime, formatPhoneBR, ORDER_TYPE_LABELS, PAYMENT_LABELS } from "./format";

/** Ponte exposta pelo app desktop (Electron) — ver apps/desktop/preload.js. Ausente no navegador comum. */
interface ElectronBridge {
  isElectron: true;
  /** `opts.widthMm`: largura do papel (58/80) — versões antigas do app ignoram e imprimem no tamanho padrão da impressora. */
  printSilently(html: string, opts?: { widthMm: number }): Promise<{ success: boolean; reason?: string }>;
  getPrinters(): Promise<{ name: string; displayName: string; isDefault: boolean }[]>;
  getSelectedPrinter(): Promise<string | null>;
  setSelectedPrinter(name: string | null): Promise<boolean>;
  getAutoLaunch(): Promise<boolean>;
  setAutoLaunch(enabled: boolean): Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridge;
  }
}

export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI?.isElectron;
}

// ---- Configurações DESTE aparelho (cada computador tem sua impressora; o telefone não imprime sozinho) ----
const PAPER_KEY = "burgerhub.paperWidthMm";
const AUTO_PRINT_DEVICE_KEY = "burgerhub.autoPrintDevice";
export type PaperWidthMm = 58 | 80;

export function getPaperWidthMm(): PaperWidthMm {
  try {
    return localStorage.getItem(PAPER_KEY) === "58" ? 58 : 80;
  } catch {
    return 80;
  }
}
export function setPaperWidthMm(width: PaperWidthMm): void {
  try {
    localStorage.setItem(PAPER_KEY, String(width));
  } catch {
    /* sem armazenamento: volta pro padrão (80 mm) */
  }
}

/** Este aparelho imprime os pedidos novos sozinho? Padrão: sim no app desktop, não no navegador/celular (precisa ligar). */
export function isAutoPrintDevice(): boolean {
  try {
    const saved = localStorage.getItem(AUTO_PRINT_DEVICE_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    /* sem armazenamento: usa o padrão */
  }
  return isDesktopApp();
}
export function setAutoPrintDevice(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_PRINT_DEVICE_KEY, enabled ? "1" : "0");
  } catch {
    /* sem armazenamento: não lembra a escolha */
  }
}

export interface PrintTenant {
  name: string;
  phone?: string | null;
  settings?: {
    address?: string | null;
    companyLegalName?: string | null;
    companyCnpj?: string | null;
    companyStateRegistration?: string | null;
    companyMunicipalRegistration?: string | null;
    companyPhone?: string | null;
  } | null;
}

/** CNPJ guardado só com dígitos → XX.XXX.XXX/XXXX-XX. */
function maskCnpj(digits: string): string {
  return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
}

/** Texto digitado por cliente/equipe (nome, observação, endereço) vai pro HTML do cupom: escapa pra não quebrar o layout. */
const esc = (value: string | null | undefined): string =>
  (value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Cabeçalho com os dados do estabelecimento, repetido em todo cupom impresso. O telefone do cadastro da loja
 * (tenant.phone) não sai aqui: é o número informado no cadastro da conta e não é necessariamente o da loja.
 */
function tenantHeader(tenant: PrintTenant): string {
  const s = tenant.settings;
  const small = (text: string) => `<p style="text-align:center;font-size:11px;margin:1px 0">${esc(text)}</p>`;
  const registrations = [
    s?.companyCnpj ? `CNPJ ${maskCnpj(s.companyCnpj)}` : "",
    s?.companyStateRegistration ? `IE ${s.companyStateRegistration}` : "",
    s?.companyMunicipalRegistration ? `IM ${s.companyMunicipalRegistration}` : "",
  ].filter(Boolean);
  return `
    <h2>${esc(tenant.name)}</h2>
    ${s?.companyLegalName && s.companyLegalName !== tenant.name ? small(s.companyLegalName) : ""}
    ${registrations.length > 0 ? small(registrations.join(" · ")) : ""}
    ${s?.address ? small(s.address) : ""}
    ${s?.companyPhone ? small(formatPhoneBR(s.companyPhone)) : ""}
  `;
}

/**
 * Estilo do cupom na largura do papel (58 ou 80 mm). @page sem margem tira o cabeçalho/rodapé do navegador e o recuo da
 * página; o conteúdo fica um pouco mais estreito que o papel (a cabeça térmica não imprime até a borda). Antes era uma
 * largura fixa de 280 px + margem, que estourava o papel e saía cortado/torto no computador. O TAMANHO do papel não
 * é definido aqui (nem `@page size`): vale o que está configurado na impressora — forçar um tamanho personalizado fez a
 * térmica soltar só ~1 cm em branco.
 */
function receiptStyle(widthMm: number): string {
  return `
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Courier New", monospace; font-size: ${widthMm <= 58 ? 11 : 12}px; width: ${widthMm - 8}mm; margin: 0 auto; padding: 2mm 0 6mm; color: #000; box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; overflow-wrap: anywhere; }
  h2 { text-align: center; margin: 4px 0; } hr { border: none; border-top: 1px dashed #000; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .title { font-weight: bold; font-size: 11px; letter-spacing: 1px; margin: 6px 0 2px; }
  .big { font-size: 28px; font-weight: bold; text-align: center; margin: 2px 0; }
  .tag { font-size: 16px; font-weight: bold; text-align: center; border: 2px solid #000; padding: 3px 0; margin: 4px 0; }
  .item { font-size: 14px; font-weight: bold; }
  .sub { padding-left: 14px; }
  .obs { padding-left: 14px; font-size: 14px; font-weight: bold; }
  .box { border: 2px solid #000; padding: 4px 6px; margin: 6px 0; font-size: 14px; font-weight: bold; }
  .total { font-size: 16px; font-weight: bold; }
`;
}

const SOURCE_LABELS: Record<string, string> = { MENU: "Cardápio online", WHATSAPP: "WhatsApp", POS: "Balcão", TABLE: "Mesa" };

/** Linha de pagamento no estilo "cobrar do cliente": a equipe vê de cara se já está pago e quanto levar de troco. */
function paymentBlock(order: Order): string {
  const method = order.paymentMethod ? (PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod) : null;
  const where = order.type === "DELIVERY" ? "na entrega" : order.type === "PICKUP" ? "na retirada" : "no local";
  const paid = order.paymentStatus === "PAID";
  const headline = paid ? `PAGO${method ? ` (${method})` : ""}` : `COBRAR ${where.toUpperCase()}${method ? `: ${method.toUpperCase()}` : ""}`;
  const change = !paid && order.changeForCents ? `<div>Troco para ${brl(order.changeForCents)} → levar ${brl(Math.max(order.changeForCents - order.totalCents, 0))}</div>` : "";
  return `<div class="box">${headline}${change}</div>`;
}

/**
 * Imprime via um iframe escondido (em vez de window.open) — window.open é
 * bloqueado pelo navegador quando chamado fora de um clique direto do
 * usuário (ex.: impressão automática disparada pelo polling de pedido novo).
 * Iframe não conta como pop-up, então funciona tanto no clique manual quanto
 * no disparo automático. Ainda assim, imprimir sem NENHUMA caixa de diálogo
 * exige o navegador rodando em modo kiosk de impressão (ex.: Chrome com
 * --kiosk-printing) — sem isso, a caixa de impressão abre automaticamente,
 * só falta confirmar.
 *
 * Dentro do app desktop (Electron), usa a ponte nativa em vez disso — imprime
 * direto na impressora escolhida, sem NENHUMA caixa de diálogo.
 */
async function printHtml(title: string, bodyHtml: string): Promise<boolean> {
  const widthMm = getPaperWidthMm();
  const fullHtml = `<html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${receiptStyle(widthMm)}</style></head><body>${bodyHtml}</body></html>`;

  if (window.electronAPI) {
    try {
      const result = await window.electronAPI.printSilently(fullHtml, { widthMm });
      if (!result.success) console.error("Falha ao imprimir:", result.reason);
      return result.success;
    } catch (err) {
      console.error("Falha ao imprimir:", err);
      return false;
    }
  }

  // Iframe fora da tela mas com tamanho de verdade: um iframe 0×0 deixa o navegador montar o cupom numa página sem largura
  // (era uma das causas da impressão "bugada" no computador).
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = `${widthMm}mm`;
  iframe.style.height = "1000px";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(iframe);
    return false;
  }
  doc.open();
  doc.write(fullHtml);
  doc.close();

  await new Promise((resolve) => setTimeout(resolve, 300));
  iframe.contentWindow?.focus();
  iframe.contentWindow?.print();
  setTimeout(() => iframe.parentNode?.removeChild(iframe), 60_000);
  return true;
}

/** Imprime formatado para impressora térmica (58 ou 80 mm, conforme a configuração deste aparelho). Devolve se a impressão foi enviada. */
export function printOrder(order: Order, tenant: PrintTenant): Promise<boolean> {
  const isDelivery = order.type === "DELIVERY";
  const addressLine = [order.addressStreet, order.addressNumber].filter(Boolean).join(", ");
  const place = [addressLine, order.addressNeighborhood].filter(Boolean).join(" — ");
  const typeLabel = (ORDER_TYPE_LABELS[order.type] ?? order.type).toUpperCase() + (order.type === "DINE_IN" && order.table ? ` — MESA ${order.table.number}` : "");
  const body = `
    ${tenantHeader(tenant)}
    <hr/>
    <div class="big">PEDIDO #${order.number}</div>
    <div class="tag">${esc(typeLabel)}</div>
    <p style="text-align:center;margin:2px 0">${formatDateTime(order.createdAt)}${order.source && SOURCE_LABELS[order.source] ? ` · ${SOURCE_LABELS[order.source]}` : ""}</p>
    <hr/>
    ${
      order.customer
        ? `<div class="title">CLIENTE</div>
    <div style="font-size:14px;font-weight:bold">${esc(order.customer.name)}</div>
    <div>${esc(formatPhoneBR(order.customer.phone))}</div>`
        : ""
    }
    ${
      isDelivery && place
        ? `<div class="title">ENDEREÇO DE ENTREGA</div>
    <div style="font-size:14px;font-weight:bold">${esc(place)}</div>
    ${order.addressComplement ? `<div style="font-weight:bold">${esc(order.addressComplement)}</div>` : ""}
    ${order.addressCity ? `<div>${esc(order.addressCity)}</div>` : ""}`
        : ""
    }
    <hr/>
    <div class="title">ITENS</div>
    ${order.items
      .map(
        (i) => `
      <div class="row item"><span>${i.quantity}x ${esc(i.nameSnapshot)}</span><span>${brl(i.unitPriceCents * i.quantity)}</span></div>
      ${i.addons.map((a) => `<div class="sub">+ ${a.quantity}x ${esc(a.nameSnapshot)}</div>`).join("")}
      ${i.removals.map((r) => `<div class="obs">SEM ${esc(r.nameSnapshot)}</div>`).join("")}
      ${i.notes ? `<div class="obs">OBS: ${esc(i.notes)}</div>` : ""}
      <div style="height:4px"></div>
    `,
      )
      .join("")}
    <hr/>
    <div class="row"><span>Subtotal</span><span>${brl(order.subtotalCents)}</span></div>
    ${order.discountCents ? `<div class="row"><span>Desconto</span><span>-${brl(order.discountCents)}</span></div>` : ""}
    ${isDelivery ? `<div class="row"><span>Taxa de entrega</span><span>${order.deliveryFeeCents ? brl(order.deliveryFeeCents) : "Grátis"}</span></div>` : ""}
    <div class="row total"><span>TOTAL</span><span>${brl(order.totalCents)}</span></div>
    ${paymentBlock(order)}
    ${order.notes ? `<div class="box">OBSERVAÇÃO DO PEDIDO:<br/>${esc(order.notes)}</div>` : ""}
    <hr/>
    <p style="text-align:center; font-size:11px">Obrigado pela preferência!</p>
    <p style="text-align:center; font-size:10px; margin:2px 0">Comprovante do pedido — não é documento fiscal</p>
  `;
  return printHtml(`Pedido #${order.number}`, body);
}

/** Botão "Imprimir": imprime e marca o pedido como impresso (a impressão automática não repete). */
export async function printOrderByHand(order: Order, tenant: PrintTenant): Promise<void> {
  const ok = await printOrder(order, tenant);
  if (ok) await api.post(`/orders/${order.id}/printed`, {}).catch(() => {});
}

/** Cupom de teste (configuração de impressora/papel): mostra a largura útil e o tamanho das letras. */
export function printTestReceipt(tenant: PrintTenant): Promise<boolean> {
  const widthMm = getPaperWidthMm();
  const body = `
    ${tenantHeader(tenant)}
    <hr/>
    <div class="big">TESTE</div>
    <div class="tag">PAPEL ${widthMm} mm</div>
    <p style="text-align:center;margin:2px 0">${esc(formatDateTime(new Date().toISOString()))}</p>
    <hr/>
    <div class="row item"><span>1x X Salada Especial</span><span>R$ 18,00</span></div>
    <div class="obs">OBS: SEM TOMATE</div>
    <div class="row"><span>Subtotal</span><span>R$ 18,00</span></div>
    <div class="row total"><span>TOTAL</span><span>R$ 18,00</span></div>
    <div class="box">COBRAR NA ENTREGA: DINHEIRO<div>Troco para R$ 50,00 → levar R$ 32,00</div></div>
    <p style="text-align:center">|<span style="display:inline-block;width:${widthMm - 12}mm;border-top:1px solid #000;vertical-align:middle"></span>|</p>
    <p style="text-align:center; font-size:10px">Se as bordas do traço acima saírem inteiras, o papel está certo.</p>
  `;
  return printHtml("Teste de impressão", body);
}

/** Cupom consolidado do fechamento de uma mesa (soma vários pedidos). */
export function printTableBill(
  orders: Order[],
  tableNumber: number,
  tenant: PrintTenant,
  splitCount?: number,
) {
  const totalCents = orders.reduce((s, o) => s + o.totalCents, 0);
  const perPerson = splitCount && splitCount > 1 ? Math.ceil(totalCents / splitCount) : null;
  const body = `
    ${tenantHeader(tenant)}
    <hr/>
    <p style="text-align:center; font-weight:bold">MESA ${tableNumber}</p>
    <p style="text-align:center">${formatDateTime(new Date().toISOString())}</p>
    <hr/>
    ${orders
      .map(
        (order) => `
      <p style="font-weight:bold">Pedido #${order.number}</p>
      ${order.items
        .map(
          (i) => `
        <div class="row"><span>${i.quantity}x ${i.nameSnapshot}</span><span>${brl(i.unitPriceCents * i.quantity)}</span></div>
        ${i.addons.map((a) => `<div style="padding-left:12px">+ ${a.quantity}x ${a.nameSnapshot}</div>`).join("")}
        ${i.removals.map((r) => `<div style="padding-left:12px">- SEM ${r.nameSnapshot}</div>`).join("")}
      `,
        )
        .join("")}
    `,
      )
      .join("<hr/>")}
    <hr/>
    <div class="row" style="font-weight:bold"><span>TOTAL</span><span>${brl(totalCents)}</span></div>
    ${perPerson ? `<div class="row"><span>Por pessoa (${splitCount}x)</span><span>${brl(perPerson)}</span></div>` : ""}
    <hr/>
    <p style="text-align:center; font-size:11px">Obrigado pela preferência!</p>
    <p style="text-align:center">BurgerHub 🍔</p>
  `;
  void printHtml(`Mesa ${tableNumber}`, body);
}
