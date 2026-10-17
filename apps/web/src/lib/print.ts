import type { Order } from "../types";
import { brl, formatDateTime, formatPhoneBR, ORDER_TYPE_LABELS, PAYMENT_LABELS } from "./format";

/** Ponte exposta pelo app desktop (Electron) — ver apps/desktop/preload.js. Ausente no navegador comum. */
interface ElectronBridge {
  isElectron: true;
  printSilently(html: string): Promise<{ success: boolean; reason?: string }>;
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

const RECEIPT_STYLE = `
  body { font-family: monospace; font-size: 12px; width: 280px; margin: 8px; }
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
function printHtml(title: string, bodyHtml: string) {
  if (window.electronAPI) {
    const fullHtml = `<html><head><title>${title}</title><style>${RECEIPT_STYLE}</style></head><body>${bodyHtml}</body></html>`;
    window.electronAPI.printSilently(fullHtml).catch((err) => console.error("Falha ao imprimir:", err));
    return;
  }

  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(iframe);
    return;
  }
  doc.open();
  doc.write(`<html><head><title>${title}</title><style>${RECEIPT_STYLE}</style></head><body>${bodyHtml}</body></html>`);
  doc.close();

  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => document.body.removeChild(iframe), 1000);
  }, 300);
}

/** Imprime formatado para impressora térmica (80mm). */
export function printOrder(order: Order, tenant: PrintTenant) {
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
  printHtml(`Pedido #${order.number}`, body);
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
  printHtml(`Mesa ${tableNumber}`, body);
}
