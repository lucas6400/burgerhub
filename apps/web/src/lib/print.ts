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
  settings?: { address?: string | null } | null;
}

/** Cabeçalho com os dados do estabelecimento, repetido em todo cupom impresso. */
function tenantHeader(tenant: PrintTenant): string {
  return `
    <h2>${tenant.name}</h2>
    ${tenant.settings?.address ? `<p style="text-align:center;font-size:11px">${tenant.settings.address}</p>` : ""}
    ${tenant.phone ? `<p style="text-align:center;font-size:11px">${formatPhoneBR(tenant.phone)}</p>` : ""}
  `;
}

const RECEIPT_STYLE = `
  body { font-family: monospace; font-size: 12px; width: 280px; margin: 8px; }
  h2 { text-align: center; margin: 4px 0; } hr { border: none; border-top: 1px dashed #000; }
  .row { display: flex; justify-content: space-between; }
`;

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
  const body = `
    ${tenantHeader(tenant)}
    <hr/>
    <div style="text-align:center; margin:6px 0">
      <p style="margin:0; font-size:11px; letter-spacing:1px">SENHA</p>
      <p style="margin:0; font-size:30px; font-weight:bold">#${order.number}</p>
    </div>
    <hr/>
    <p style="text-align:center">${formatDateTime(order.createdAt)} — ${ORDER_TYPE_LABELS[order.type]}</p>
    <hr/>
    ${order.items
      .map(
        (i) => `
      <div class="row"><span>${i.quantity}x ${i.nameSnapshot}</span><span>${brl(i.unitPriceCents * i.quantity)}</span></div>
      ${i.addons.map((a) => `<div style="padding-left:12px">+ ${a.quantity}x ${a.nameSnapshot}</div>`).join("")}
      ${i.removals.map((r) => `<div style="padding-left:12px">- SEM ${r.nameSnapshot}</div>`).join("")}
      ${i.notes ? `<div style="padding-left:12px">Obs: ${i.notes}</div>` : ""}
    `,
      )
      .join("")}
    <hr/>
    <div class="row"><span>Subtotal</span><span>${brl(order.subtotalCents)}</span></div>
    ${order.discountCents ? `<div class="row"><span>Desconto</span><span>-${brl(order.discountCents)}</span></div>` : ""}
    ${order.deliveryFeeCents ? `<div class="row"><span>Entrega</span><span>${brl(order.deliveryFeeCents)}</span></div>` : ""}
    <div class="row" style="font-weight:bold"><span>TOTAL</span><span>${brl(order.totalCents)}</span></div>
    <hr/>
    <p>Pagamento: ${order.paymentMethod ? PAYMENT_LABELS[order.paymentMethod] : "A COBRAR NA ENTREGA"}${order.changeForCents ? ` (troco p/ ${brl(order.changeForCents)})` : ""}</p>
    ${order.customer ? `<p>Cliente: ${order.customer.name}<br/>Tel: ${order.customer.phone}</p>` : ""}
    ${order.addressStreet ? `<p>Endereço: ${order.addressStreet}, ${order.addressNumber} — ${order.addressNeighborhood}${order.addressComplement ? ` (${order.addressComplement})` : ""}</p>` : ""}
    ${order.notes ? `<p>Obs: ${order.notes}</p>` : ""}
    <hr/>
    <p style="text-align:center; font-size:11px">Obrigado pela preferência!</p>
    <p style="text-align:center">BurgerHub 🍔</p>
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
