import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, CheckCircle2, MessageCircle, Smartphone, Sparkles, Unplug } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { BroadcastCard } from "./BroadcastCard";
import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, Toggle } from "../components/ui";

interface WaStatus {
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED";
  qrImage?: string;
  number?: string;
  botEnabled?: boolean;
  aiConversationEnabled?: boolean;
  followUpEnabled?: boolean;
  waLabelsEnabled?: boolean;
  lateOrderAlertEnabled?: boolean;
  lateOrderNotifyCustomer?: boolean;
}

interface Messages {
  msgOrderReceived: string;
  msgOrderLate: string;
  msgOrderPreparing: string;
  msgOrderOut: string;
  msgOrderDelivered: string;
}

export function WhatsAppPage() {
  const { tenant } = useAuth();
  const [wa, setWa] = useState<WaStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Messages | null>(null);
  const [saved, setSaved] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qrRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (qrRefreshRef.current) {
      clearInterval(qrRefreshRef.current);
      qrRefreshRef.current = null;
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

  /** Busca um QR novo sem mexer nos estados de loading/erro — usado na renovação automática. */
  const fetchQr = useCallback(async () => {
    const info = await api.post<WaStatus>("/whatsapp/connect");
    if (info.qrImage) {
      setQrImage(info.qrImage);
      setWa((prev) => ({ ...info, botEnabled: prev?.botEnabled ?? info.botEnabled }));
    }
    return info;
  }, []);

  async function connect() {
    setError("");
    setConnecting(true);
    try {
      const info = await fetchQr();
      if (info.qrImage) {
        stopPolling();
        pollRef.current = setInterval(refreshStatus, 3000);
        // O QR do WhatsApp expira em poucos segundos (igual no site oficial) — sem
        // renovar sozinho, quem demorasse um pouco pra escanear caía num código
        // vencido e o celular recusava com um erro genérico.
        qrRefreshRef.current = setInterval(() => {
          fetchQr().catch(() => {});
        }, 25_000);
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

  async function toggleAiConversation(aiConversationEnabled: boolean) {
    setWa((prev) => (prev ? { ...prev, aiConversationEnabled } : prev));
    await api.put("/settings", { aiConversationEnabled });
  }

  async function toggleFollowUp(followUpEnabled: boolean) {
    setWa((prev) => (prev ? { ...prev, followUpEnabled } : prev));
    await api.put("/settings", { followUpEnabled });
  }

  const [labelInfo, setLabelInfo] = useState<{ total: number; names?: string[]; stages: { stage: string; name: string; found: boolean }[] } | null>(null);
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState("");

  async function toggleLateNotifyCustomer(lateOrderNotifyCustomer: boolean) {
    setWa((prev) => (prev ? { ...prev, lateOrderNotifyCustomer } : prev));
    await api.put("/settings", { lateOrderNotifyCustomer });
  }

  async function toggleLateAlert(lateOrderAlertEnabled: boolean) {
    setWa((prev) => (prev ? { ...prev, lateOrderAlertEnabled } : prev));
    await api.put("/settings", { lateOrderAlertEnabled });
  }

  async function toggleLabels(waLabelsEnabled: boolean) {
    setWa((prev) => (prev ? { ...prev, waLabelsEnabled } : prev));
    await api.put("/settings", { waLabelsEnabled });
  }
  async function checkLabels() {
    setTestResult("");
    try {
      setLabelInfo(await api.get("/whatsapp/labels/status"));
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "Não consegui consultar as etiquetas.");
    }
  }
  async function testLabel(stage: string) {
    setTestResult("Aplicando...");
    try {
      const r = await api.post<{ ok: boolean; soft?: boolean; detail?: string }>("/whatsapp/labels/test", { phone: testPhone.replace(/\D/g, ""), stage });
      setTestResult(r.ok ? (r.soft ? "✓ Comando enviado ao WhatsApp (a Evolution só reclamou do registro interno dela). Abra a conversa desse número no celular e veja se a etiqueta apareceu — se apareceu, pode ligar as etiquetas automáticas." : "✓ O WhatsApp confirmou. Abra a conversa desse número no celular e veja se a etiqueta apareceu.") : `✗ Não deu certo. Motivo: ${r.detail || "sem detalhe"}`);
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "Erro ao testar.");
    }
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
              👋 Bem-vindo à {tenant?.name ?? "sua hamburgueria"}!<br />
              1️⃣ Fazer pedido 🍔<br />
              2️⃣ Cardápio com fotos 📱<br />
              3️⃣ Horários 🕐
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles size={16} /> Conversa livre com IA
                <Badge color="amber">Beta</Badge>
              </h3>
              <Toggle
                checked={wa?.aiConversationEnabled ?? false}
                onChange={toggleAiConversation}
              />
            </div>
            <p className="text-xs leading-relaxed text-surface-500">
              Quando ativo, substitui o menu numerado acima: a IA conduz a conversa inteira, sem
              código de lanche — o cliente fala naturalmente ("quero um x-bacon e um refri") e ela
              mesmo monta o carrinho, calcula a entrega e fecha o pedido. Ainda em teste — recomendamos
              ativar só depois de validar com um número de testes.
            </p>
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Retomar leads que sumiram</h3>
              <Toggle checked={wa?.followUpEnabled ?? false} onChange={toggleFollowUp} />
            </div>
            <p className="text-xs leading-relaxed text-surface-500">
              Em até duas etapas: quando o cliente pergunta e depois de 30 min não responde mais, o bot manda uma mensagem
              curta pra tentar retomar; se continuar sem resposta, manda uma segunda perto do horário de fechamento
              ("últimos pedidos da noite"). Só com a loja aberta, só quem escreveu nas últimas 5h, e nunca pra quem já
              pediu, recusou ou está sendo atendido por você. Use com moderação: muita mensagem não pedida pode levar o
              WhatsApp a bloquear o número.
            </p>
          </Card>

          <BroadcastCard />

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Avisar pedido atrasado</h3>
              <Toggle checked={wa?.lateOrderAlertEnabled ?? false} onChange={toggleLateAlert} />
            </div>
            <p className="text-xs leading-relaxed text-surface-500">
              Quando um pedido passa do tempo prometido ao cliente (tempo de preparo + 20 min), o sistema manda um aviso no seu
              WhatsApp de avisos (o mesmo dos pedidos novos, configurado em Configurações → Geral) com o número do pedido, o
              status, o bairro e o telefone do cliente. Um aviso por pedido.
            </p>
            <div className="mt-3 flex items-center justify-between border-t border-surface-100 pt-3 dark:border-surface-800">
              <span className="text-sm font-medium">Avisar também o cliente</span>
              <Toggle checked={wa?.lateOrderNotifyCustomer ?? false} onChange={toggleLateNotifyCustomer} />
            </div>
            <p className="mt-1 text-xs text-surface-500">
              O cliente recebe uma mensagem pedindo desculpa pela espera (o texto fica em "Mensagens automáticas de status"). Não
              manda se você já estiver conversando com ele.
            </p>
          </Card>

          <Card className="space-y-3 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Etiquetas automáticas (WhatsApp Business)</h3>
              <Toggle checked={wa?.waLabelsEnabled ?? false} onChange={toggleLabels} />
            </div>
            <p className="text-xs leading-relaxed text-surface-500">
              O sistema coloca cada lead numa etiqueta conforme a etapa: <b>Perguntando</b>, <b>Montando pedido</b>, <b>Pediu</b>,{" "}
              <b>Sumiu</b> e <b>Fora da área</b>. Crie essas 5 etiquetas no app do WhatsApp Business (Ferramentas → Etiquetas) com
              exatamente esses nomes — o sistema só usa as que existirem.
            </p>
            <Button variant="secondary" size="sm" onClick={checkLabels}>Ver etiquetas encontradas</Button>
            {labelInfo && (
              <ul className="space-y-1 text-xs">
                {labelInfo.stages.map((s) => (
                  <li key={s.stage}>{s.found ? "✅" : "❌"} {s.name}{s.found ? "" : " — crie no app do WhatsApp Business"}</li>
                ))}
                {labelInfo.names && labelInfo.names.length > 0 && (
                  <li className="pt-1 text-surface-500">O WhatsApp devolveu: {labelInfo.names.join(", ")}</li>
                )}
                {labelInfo.total === 0 && <li className="text-amber-600">Nenhuma etiqueta veio do WhatsApp — o número pode não ser Business.</li>}
              </ul>
            )}
            <div className="space-y-2 border-t border-surface-100 pt-3 dark:border-surface-800">
              <p className="text-xs text-surface-500">Testar: informe seu número (com DDD) e aplique uma etiqueta numa conversa sua.</p>
              <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="63 98400-0289" inputMode="tel" />
              <div className="flex flex-wrap gap-2">
                {["ASKING", "ORDERED", "GHOSTED"].map((st) => (
                  <Button key={st} variant="secondary" size="sm" disabled={testPhone.replace(/\D/g, "").length < 10} onClick={() => testLabel(st)}>
                    {st === "ASKING" ? "Perguntando" : st === "ORDERED" ? "Pediu" : "Sumiu"}
                  </Button>
                ))}
              </div>
              {testResult && <p className="text-xs">{testResult}</p>}
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
                <Field label="Pedido recebido (pedidos feitos direto pelo cardápio digital)">
                  <Input
                    defaultValue={messages.msgOrderReceived}
                    onBlur={(e) => saveMessages({ msgOrderReceived: e.target.value })}
                  />
                </Field>
                <Field label="Pedido atrasado (aviso ao cliente)">
                  <Input
                    defaultValue={messages.msgOrderLate}
                    onBlur={(e) => saveMessages({ msgOrderLate: e.target.value })}
                  />
                </Field>
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
