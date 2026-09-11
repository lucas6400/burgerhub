import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, MessageCircle, Smartphone, Unplug } from "lucide-react";
import { api } from "../lib/api";
import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, Toggle } from "../components/ui";

interface WaStatus {
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED";
  qrImage?: string;
  number?: string;
  botEnabled?: boolean;
}

interface Messages {
  msgOrderPreparing: string;
  msgOrderOut: string;
  msgOrderDelivered: string;
}

export function WhatsAppPage() {
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Messages | null>(null);
  const [saved, setSaved] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await api.get<WaStatus>("/whatsapp/status");
      setWa(status);
      if (status.status === "CONNECTED") {
        setQrImage(null);
        stopPolling();
      }
      return status;
    } catch {
      return null;
    }
  }, [stopPolling]);

  useEffect(() => {
    refreshStatus();
    api
      .get<{ settings: Messages }>("/settings")
      .then((d) => setMessages(d.settings))
      .catch(console.error);
    return stopPolling;
  }, [refreshStatus, stopPolling]);

  async function connect() {
    setError("");
    setConnecting(true);
    try {
      const info = await api.post<WaStatus>("/whatsapp/connect");
      if (info.qrImage) {
        setQrImage(info.qrImage);
        setWa({ ...info, botEnabled: wa?.botEnabled });
        stopPolling();
        pollRef.current = setInterval(refreshStatus, 3000);
      } else {
        await refreshStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao conectar");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect() {
    await api.post("/whatsapp/disconnect");
    setQrImage(null);
    stopPolling();
    refreshStatus();
  }

  async function saveMessages(patch: Partial<Messages>) {
    if (!messages) return;
    setMessages({ ...messages, ...patch });
    await api.put("/settings", patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function toggleBot(botEnabled: boolean) {
    setWa((prev) => (prev ? { ...prev, botEnabled } : prev));
    await api.put("/settings", { botEnabled });
  }

  const connected = wa?.status === "CONNECTED";

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="WhatsApp"
        subtitle="Atendimento e pedidos automáticos direto no seu número"
        actions={saved ? <Badge color="green">✓ Salvo</Badge> : undefined}
      />

      <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
        {/* ---------- Conexão ---------- */}
        <Card className="p-6">
          {!wa ? (
            <Skeleton className="h-48" />
          ) : connected ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15">
                <CheckCircle2 size={32} className="text-emerald-500" />
              </span>
              <div>
                <p className="text-lg font-semibold">WhatsApp conectado!</p>
                {wa.number && (
                  <p className="mt-0.5 flex items-center justify-center gap-1.5 text-sm text-surface-500">
                    <Smartphone size={14} /> {wa.number}
                  </p>
                )}
              </div>
              <p className="max-w-xs text-xs text-surface-400">
                Seus clientes já podem pedir pelo WhatsApp e receber as atualizações do pedido
                automaticamente.
              </p>
              <Button variant="danger" size="sm" onClick={disconnect}>
                <Unplug size={14} /> Desconectar
              </Button>
            </div>
          ) : qrImage ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <p className="font-semibold">Escaneie com o seu WhatsApp</p>
              <img
                src={qrImage}
                alt="QR Code de conexão"
                className="h-56 w-56 rounded-2xl border border-surface-200 bg-white p-2 dark:border-surface-700"
              />
              <ol className="space-y-1 text-left text-xs text-surface-500">
                <li>1. Abra o <strong>WhatsApp</strong> no celular do restaurante</li>
                <li>2. Toque em <strong>⋮ &gt; Dispositivos conectados</strong></li>
                <li>3. Toque em <strong>Conectar dispositivo</strong> e aponte para o código</li>
              </ol>
              <p className="flex items-center gap-2 text-xs text-surface-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                Aguardando leitura...
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15">
                <MessageCircle size={30} className="text-emerald-500" />
              </span>
              <div>
                <p className="text-lg font-semibold">Conecte seu WhatsApp</p>
                <p className="mx-auto mt-1 max-w-xs text-sm text-surface-500">
                  Em menos de 1 minuto: clique no botão, escaneie o QR Code e comece a receber
                  pedidos.
                </p>
              </div>
              {error && (
                <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
              <Button size="lg" onClick={connect} disabled={connecting}>
                {connecting ? "Gerando QR Code..." : "Conectar WhatsApp"}
              </Button>
            </div>
          )}
        </Card>

        {/* ---------- Bot ---------- */}
        <div className="space-y-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Bot size={16} /> Atendente automático
              </h3>
              <Toggle checked={wa?.botEnabled ?? true} onChange={toggleBot} />
            </div>
            <p className="text-xs leading-relaxed text-surface-500">
              Quando ativo, o bot atende sozinho: envia o cardápio, monta o pedido pelos{" "}
              <strong>códigos dos lanches</strong> (os mesmos do PDV), coleta endereço e pagamento e
              registra tudo direto na cozinha. O cliente digita <em>“2x3”</em> e pronto.
            </p>
            <div className="mt-3 rounded-xl bg-surface-50 p-3 font-mono text-[11px] leading-relaxed text-surface-500 dark:bg-surface-850">
              👋 Bem-vindo à Burger do Lu!<br />
              1️⃣ Fazer pedido 🍔<br />
              2️⃣ Cardápio com fotos 📱<br />
              3️⃣ Horários 🕐
            </div>
          </Card>

          <Card className="space-y-3 p-5">
            <h3 className="text-sm font-semibold">Mensagens automáticas de status</h3>
            <p className="text-xs text-surface-400">
              Enviadas quando o pedido muda de etapa. Use <code>{"{n}"}</code> para o número do
              pedido.
            </p>
            {!messages ? (
              <Skeleton className="h-32" />
            ) : (
              <>
                <Field label="Pedido em preparo">
                  <Input
                    defaultValue={messages.msgOrderPreparing}
                    onBlur={(e) => saveMessages({ msgOrderPreparing: e.target.value })}
                  />
                </Field>
                <Field label="Saiu para entrega">
                  <Input
                    defaultValue={messages.msgOrderOut}
                    onBlur={(e) => saveMessages({ msgOrderOut: e.target.value })}
                  />
                </Field>
                <Field label="Pedido entregue">
                  <Input
                    defaultValue={messages.msgOrderDelivered}
                    onBlur={(e) => saveMessages({ msgOrderDelivered: e.target.value })}
                  />
                </Field>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
