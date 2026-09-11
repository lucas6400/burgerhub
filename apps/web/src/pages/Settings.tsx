import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Crosshair, MapPin, Plus, QrCode, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { brl, formatCep, parseBrl, ROLE_LABELS } from "../lib/format";
import { useAuth } from "../stores/auth";
import { LocationPickerMap } from "../components/LocationPickerMap";
import { ImageUploadField } from "../components/ImageUploadField";
import { isDesktopApp } from "../lib/print";
import { AuditLogTab } from "./settings/AuditLogTab";
import { LoyaltyTab } from "./settings/LoyaltyTab";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Toggle,
} from "../components/ui";

const DEFAULT_MAP_CENTER = { lat: -14.235, lng: -51.9253 }; // centro do Brasil

interface SettingsData {
  tenant: { name: string; slug: string; phone?: string | null };
  settings: {
    logoUrl?: string | null;
    bannerUrl?: string | null;
    address?: string | null;
    instagram?: string | null;
    pixKey?: string | null;
    acceptsDelivery: boolean;
    acceptsPickup: boolean;
    acceptsDineIn: boolean;
    kdsEnabled: boolean;
    autoPrint: boolean;
    defaultPrepMinutes: number;
    minOrderCents: number;
    freeDeliveryAbove?: number | null;
    storeLat?: number | null;
    storeLng?: number | null;
    maxDeliveryRadiusKm: number;
    isOpenOverride?: boolean | null;
    closedMessage: string;
    mpEnabled: boolean;
    mpConfigured: boolean;
    mpPublicKey?: string | null;
    ifoodEnabled: boolean;
    ifoodConfigured: boolean;
    ifoodMerchantId?: string | null;
    ifoodClientId?: string | null;
  };
  businessHours: { weekday: number; openTime: string; closeTime: string; closed: boolean }[];
  deliveryRadiusTiers: {
    id: string;
    maxKm: number;
    feeCents: number;
    etaMinutes: number;
    active: boolean;
  }[];
}

interface TeamUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
}

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const TABS = [
  "Geral",
  "Horários",
  "Entrega",
  "Pagamentos",
  "iFood",
  "Fidelidade",
  "Equipe",
  "Auditoria",
  "QR Code",
] as const;

export function SettingsPage() {
  const { tenant, user, updateTenantName, updateTenantSlug, updateTenantSettings } = useAuth();
  const canViewAudit = user?.role === "ADMIN" || user?.role === "MANAGER";
  const [searchParams, setSearchParams] = useSearchParams();
  // Volta da conexão OAuth do Mercado Pago já cai direto na aba certa, com o resultado.
  const mpOauthResult = searchParams.get("mp");
  const initialTab = (TABS as readonly string[]).includes(searchParams.get("tab") ?? "")
    ? (searchParams.get("tab") as (typeof TABS)[number])
    : "Geral";
  const [data, setData] = useState<SettingsData | null>(null);
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number]>(initialTab);
  const [connectingMp, setConnectingMp] = useState(false);
  const [disconnectingMp, setDisconnectingMp] = useState(false);
  const [mpConnectError, setMpConnectError] = useState("");
  const [saved, setSaved] = useState(false);
  const [tierModal, setTierModal] = useState(false);
  const [userModal, setUserModal] = useState(false);
  const [tierForm, setTierForm] = useState({ maxKm: "", fee: "", eta: "45" });
  const [userForm, setUserForm] = useState({ name: "", email: "", password: "", role: "ATTENDANT" });
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");
  const [mapModal, setMapModal] = useState(false);
  const [draftPoint, setDraftPoint] = useState(DEFAULT_MAP_CENTER);
  const [locatingBrowser, setLocatingBrowser] = useState(false);
  const [tenantNameError, setTenantNameError] = useState("");
  const [tenantSlugError, setTenantSlugError] = useState("");
  const [cep, setCep] = useState("");
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState("");
  const addressInputRef = useRef<HTMLInputElement>(null);

  function load() {
    api.get<SettingsData>("/settings").then(setData).catch(console.error);
    api.get<TeamUser[]>("/settings/users").then(setUsers).catch(() => {});
  }
  useEffect(load, []);

  // Tira o ?mp=.../&tab=... da URL depois de mostrar o resultado, pra não
  // reaparecer num reload da página.
  useEffect(() => {
    if (!mpOauthResult) return;
    const next = new URLSearchParams(searchParams);
    next.delete("mp");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpOauthResult]);

  async function connectMercadoPago() {
    setConnectingMp(true);
    setMpConnectError("");
    try {
      const { url } = await api.get<{ url: string }>("/payments/mercadopago/connect");
      window.location.href = url;
    } catch (err) {
      setMpConnectError(err instanceof Error ? err.message : "Erro ao iniciar conexão com o Mercado Pago");
      setConnectingMp(false);
    }
  }

  async function disconnectMercadoPago() {
    if (!confirm("Desconectar o Mercado Pago? Pagamentos online ficam indisponíveis até reconectar.")) return;
    setDisconnectingMp(true);
    try {
      await api.post("/payments/mercadopago/disconnect", {});
      load();
    } catch (err) {
      setMpConnectError(err instanceof Error ? err.message : "Erro ao desconectar o Mercado Pago");
    } finally {
      setDisconnectingMp(false);
    }
  }

  async function saveSettings(patch: Partial<SettingsData["settings"]>) {
    if (!data) return;
    const updated = { ...data.settings, ...patch };
    setData({ ...data, settings: updated });
    await api.put("/settings", patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function lookupCep(rawCep: string) {
    const digits = rawCep.replace(/\D/g, "");
    if (digits.length !== 8) return;
    setCepError("");
    setCepLoading(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      const found = await res.json();
      if (found.erro) {
        setCepError("CEP não encontrado. Digite o endereço manualmente.");
        return;
      }
      const street: string = found.logradouro ?? "";
      const composed =
        street +
        (found.bairro ? ` - ${found.bairro}` : "") +
        (found.localidade && found.uf ? `, ${found.localidade} - ${found.uf}` : "");
      if (addressInputRef.current) {
        addressInputRef.current.value = composed;
        addressInputRef.current.focus();
        // Cursor logo após o nome da rua — só falta o número/lote.
        const pos = street ? street.length : 0;
        addressInputRef.current.setSelectionRange(pos, pos);
      }
      await saveSettings({ address: composed || null });
    } catch {
      setCepError("Não foi possível buscar esse CEP agora. Digite o endereço manualmente.");
    } finally {
      setCepLoading(false);
    }
  }

  async function toggleUserActive(u: TeamUser, active: boolean) {
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, active } : x)));
    try {
      await api.put(`/settings/users/${u.id}`, { active });
    } catch (err) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, active: !active } : x)));
      alert(err instanceof Error ? err.message : "Erro ao atualizar usuário");
    }
  }

  async function removeUser(u: TeamUser) {
    if (!confirm(`Remover ${u.name} da equipe?`)) return;
    try {
      await api.delete(`/settings/users/${u.id}`);
      api.get<TeamUser[]>("/settings/users").then(setUsers).catch(() => {});
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao remover usuário");
    }
  }

  async function detectLocation() {
    if (!data?.settings.address) return;
    setLocating(true);
    setLocateError("");
    try {
      const point = await api.post<{ lat: number; lng: number }>("/settings/geocode", {
        address: data.settings.address,
      });
      await saveSettings({ storeLat: point.lat, storeLng: point.lng });
    } catch (err) {
      setLocateError(err instanceof Error ? err.message : "Não conseguimos localizar esse endereço.");
    } finally {
      setLocating(false);
    }
  }

  function openMapModal() {
    setDraftPoint(
      data?.settings.storeLat != null && data.settings.storeLng != null
        ? { lat: data.settings.storeLat, lng: data.settings.storeLng }
        : DEFAULT_MAP_CENTER,
    );
    setMapModal(true);
  }

  function useBrowserLocationForMap() {
    if (!navigator.geolocation) return;
    setLocatingBrowser(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDraftPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocatingBrowser(false);
      },
      () => setLocatingBrowser(false),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function confirmMapLocation() {
    await saveSettings({ storeLat: draftPoint.lat, storeLng: draftPoint.lng });
    setMapModal(false);
    // Quem define a localização pelo mapa/GPS nunca digita um endereço — sem
    // isso, o cardápio digital não tem o que mostrar pro cliente na retirada.
    // Só preenche se ainda estiver vazio, pra nunca sobrescrever um texto já digitado.
    if (!data?.settings.address) {
      try {
        const { address } = await api.post<{ address: string | null }>("/settings/reverse-geocode", {
          lat: draftPoint.lat,
          lng: draftPoint.lng,
        });
        if (address) await saveSettings({ address });
      } catch {
        // Falha silenciosa — o lojista ainda pode digitar o endereço manualmente
      }
    }
  }

  async function saveTenantName(name: string) {
    const trimmed = name.trim();
    if (!data || !trimmed || trimmed === data.tenant.name) return;
    setTenantNameError("");
    try {
      const updated = await api.put<{ name: string }>("/settings/tenant-name", { name: trimmed });
      setData({ ...data, tenant: { ...data.tenant, name: updated.name } });
      updateTenantName(updated.name);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setTenantNameError(err instanceof Error ? err.message : "Erro ao renomear");
    }
  }

  async function saveTenantSlug(rawSlug: string) {
    const slug = rawSlug.trim().toLowerCase();
    if (!data || !slug || slug === tenant?.slug) return;
    setTenantSlugError("");
    try {
      const updated = await api.put<{ slug: string }>("/settings/tenant-slug", { slug });
      updateTenantSlug(updated.slug);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setTenantSlugError(err instanceof Error ? err.message : "Erro ao mudar o endereço");
    }
  }

  async function saveHours() {
    if (!data) return;
    await api.put("/settings/business-hours", data.businessHours);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (!data) {
    return (
      <div>
        <PageHeader title="Configurações" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  const s = data.settings;
  const menuUrl = `${window.location.origin}/cardapio/${tenant?.slug}`;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Configurações"
        subtitle={data.tenant.name}
        actions={saved ? <Badge color="green">✓ Salvo</Badge> : undefined}
      />

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
        {TABS.filter((t) => t !== "Auditoria" || canViewAudit).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t
                ? "bg-brand-500 text-white"
                : "bg-surface-100 text-surface-500 hover:bg-surface-200 dark:bg-surface-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Geral" && (
        <Card className="max-w-2xl space-y-4 p-5">
          <Field label="Nome do restaurante">
            <Input
              defaultValue={data.tenant.name}
              onBlur={(e) => saveTenantName(e.target.value)}
            />
          </Field>
          {tenantNameError && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {tenantNameError}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <ImageUploadField
              label="Logo"
              value={s.logoUrl ?? ""}
              onChange={(url) => saveSettings({ logoUrl: url || null })}
            />
            <ImageUploadField
              label="Banner"
              value={s.bannerUrl ?? ""}
              onChange={(url) => saveSettings({ bannerUrl: url || null })}
            />
          </div>
          <Field label="CEP">
            <div className="flex items-center gap-2">
              <Input
                value={cep}
                onChange={(e) => {
                  const formatted = formatCep(e.target.value);
                  setCep(formatted);
                  setCepError("");
                  if (formatted.replace(/\D/g, "").length === 8) lookupCep(formatted);
                }}
                placeholder="00000-000"
                inputMode="numeric"
                className="max-w-[10rem]"
              />
              {cepLoading && <span className="text-xs text-surface-400">Buscando...</span>}
            </div>
            {cepError && <p className="mt-1.5 text-xs text-red-500">{cepError}</p>}
          </Field>
          <Field label="Endereço">
            <Input
              ref={addressInputRef}
              defaultValue={s.address ?? ""}
              onBlur={(e) => saveSettings({ address: e.target.value || null })}
              placeholder="Preenchido automaticamente pelo CEP — complete com o número/lote"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Instagram">
              <Input
                defaultValue={s.instagram ?? ""}
                onBlur={(e) => saveSettings({ instagram: e.target.value || null })}
              />
            </Field>
            <Field label="Chave Pix">
              <Input
                defaultValue={s.pixKey ?? ""}
                onBlur={(e) => saveSettings({ pixKey: e.target.value || null })}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tempo médio de preparo (min)">
              <Input
                type="number"
                defaultValue={s.defaultPrepMinutes}
                onBlur={(e) => saveSettings({ defaultPrepMinutes: parseInt(e.target.value) || 30 })}
              />
            </Field>
            <Field label="Pedido mínimo (R$)">
              <Input
                defaultValue={s.minOrderCents ? (s.minOrderCents / 100).toFixed(2).replace(".", ",") : ""}
                onBlur={(e) => saveSettings({ minOrderCents: e.target.value ? parseBrl(e.target.value) : 0 })}
              />
            </Field>
          </div>
          <div className="space-y-3 border-t border-surface-100 pt-4 dark:border-surface-800">
            <Toggle
              checked={s.acceptsDelivery}
              onChange={(v) => saveSettings({ acceptsDelivery: v })}
              label="Aceita entrega"
            />
            <Toggle
              checked={s.acceptsPickup}
              onChange={(v) => saveSettings({ acceptsPickup: v })}
              label="Aceita retirada"
            />
            <Toggle
              checked={s.acceptsDineIn}
              onChange={(v) => saveSettings({ acceptsDineIn: v })}
              label="Aceita consumo no local"
            />
            <Toggle
              checked={s.kdsEnabled}
              onChange={(v) => {
                saveSettings({ kdsEnabled: v });
                updateTenantSettings({ kdsEnabled: v });
              }}
              label="Usar tela de Cozinha (KDS)"
            />
            <p className="pl-0.5 text-xs text-surface-400">
              Desative se sua loja trabalha só com o PDV, sem fluxo de cozinha — some do menu e os pedidos podem ser concluídos direto em Pedidos.
            </p>
            <Toggle
              checked={s.autoPrint}
              onChange={(v) => {
                saveSettings({ autoPrint: v });
                updateTenantSettings({ autoPrint: v });
              }}
              label="Imprimir pedidos automaticamente"
            />
            <p className="pl-0.5 text-xs text-surface-400">
              Ao chegar um pedido novo (cardápio, WhatsApp, PDV ou mesa), abre a impressão sozinho no computador com
              esta tela aberta — pode ser o PDV, o KDS ou qualquer outra.{" "}
              {isDesktopApp()
                ? "Sai direto na impressora escolhida abaixo, sem nenhuma caixa de diálogo."
                : "Sem configurar o navegador em modo kiosk de impressão, ainda aparece a caixa de confirmação de impressão; use o app desktop do BurgerHub pra imprimir 100% sozinho, sem essa etapa."}
            </p>
            {isDesktopApp() && <DesktopPrinterField />}
            <Toggle
              checked={s.isOpenOverride === true}
              onChange={(v) => saveSettings({ isOpenOverride: v ? true : null })}
              label="Forçar loja ABERTA (ignora horários)"
            />
          </div>
        </Card>
      )}

      {tab === "Horários" && (
        <Card className="max-w-xl p-5">
          <div className="space-y-3">
            {data.businessHours.map((h, i) => (
              <div key={h.weekday} className="flex items-center gap-3">
                <span className="w-24 text-sm font-medium">{WEEKDAYS[h.weekday]}</span>
                <Input
                  type="time"
                  value={h.openTime}
                  className="w-32"
                  disabled={h.closed}
                  onChange={(e) => {
                    const hours = [...data.businessHours];
                    hours[i] = { ...h, openTime: e.target.value };
                    setData({ ...data, businessHours: hours });
                  }}
                />
                <span className="text-surface-400">às</span>
                <Input
                  type="time"
                  value={h.closeTime}
                  className="w-32"
                  disabled={h.closed}
                  onChange={(e) => {
                    const hours = [...data.businessHours];
                    hours[i] = { ...h, closeTime: e.target.value };
                    setData({ ...data, businessHours: hours });
                  }}
                />
                <Toggle
                  checked={!h.closed}
                  onChange={(v) => {
                    const hours = [...data.businessHours];
                    hours[i] = { ...h, closed: !v };
                    setData({ ...data, businessHours: hours });
                  }}
                  label={h.closed ? "Fechado" : "Aberto"}
                />
              </div>
            ))}
          </div>
          <Field label="Mensagem quando fechado">
            <div className="mt-4">
              <Input
                defaultValue={s.closedMessage}
                onBlur={(e) => saveSettings({ closedMessage: e.target.value })}
              />
            </div>
          </Field>
          <Button className="mt-4" onClick={saveHours}>
            Salvar horários
          </Button>
        </Card>
      )}

      {tab === "Entrega" && (
        <div className="max-w-2xl space-y-4">
          <Card className="p-5">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <MapPin size={15} /> Localização do estabelecimento
            </h3>
            <p className="mb-3 text-xs text-surface-500">
              Usamos isso para calcular a taxa de entrega automaticamente pela distância —
              o cliente nunca escolhe a taxa, ela é sempre a real.
            </p>
            {s.storeLat != null && s.storeLng != null ? (
              <div className="mb-3 flex items-center justify-between rounded-xl bg-emerald-500/10 px-3 py-2.5 text-sm">
                <span className="text-emerald-700 dark:text-emerald-400">
                  ✓ Localização configurada ({s.storeLat.toFixed(5)}, {s.storeLng.toFixed(5)})
                </span>
                <a
                  href={`https://www.google.com/maps?q=${s.storeLat},${s.storeLng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  Ver no mapa
                </a>
              </div>
            ) : (
              <p className="mb-3 rounded-xl bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
                Localização ainda não configurada. A entrega ficará indisponível até configurar.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={detectLocation}
                disabled={locating || !s.address}
              >
                {locating ? "Localizando..." : "Detectar pelo endereço cadastrado"}
              </Button>
              <Button variant="secondary" size="sm" onClick={openMapModal}>
                <MapPin size={14} /> Selecionar no mapa
              </Button>
            </div>
            {!s.address && (
              <p className="mt-1.5 text-xs text-surface-400">
                Cadastre o endereço na aba Geral primeiro, ou marque a localização direto no mapa.
              </p>
            )}
            {locateError && (
              <p className="mt-1.5 text-xs text-red-500">
                {locateError} Tente marcar a localização direto no mapa.
              </p>
            )}
          </Card>

          <Card className="p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Raio máximo de entrega (km)">
                <Input
                  type="number"
                  step="0.5"
                  defaultValue={s.maxDeliveryRadiusKm}
                  onBlur={(e) =>
                    saveSettings({ maxDeliveryRadiusKm: parseFloat(e.target.value) || 10 })
                  }
                />
              </Field>
              <Field label="Frete grátis acima de (R$)">
                <Input
                  defaultValue={
                    s.freeDeliveryAbove ? (s.freeDeliveryAbove / 100).toFixed(2).replace(".", ",") : ""
                  }
                  placeholder="80,00 (vazio = desativado)"
                  onBlur={(e) =>
                    saveSettings({ freeDeliveryAbove: e.target.value ? parseBrl(e.target.value) : null })
                  }
                />
              </Field>
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">Faixas de entrega por distância</h3>
                <p className="text-xs text-surface-500">
                  Ex.: até 3 km custa R$5, até 6 km custa R$8...
                </p>
              </div>
              <Button size="sm" onClick={() => setTierModal(true)}>
                <Plus size={14} /> Nova faixa
              </Button>
            </div>
            <div className="divide-y divide-surface-100 dark:divide-surface-800">
              {data.deliveryRadiusTiers.map((t) => (
                <div key={t.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="flex-1 font-medium">Até {t.maxKm} km</span>
                  <span className="text-surface-500">{brl(t.feeCents)}</span>
                  <span className="text-xs text-surface-400">{t.etaMinutes} min</span>
                  <button
                    onClick={async () => {
                      await api.delete(`/settings/delivery-radius/${t.id}`);
                      load();
                    }}
                    className="rounded-lg p-1 text-surface-300 hover:text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {data.deliveryRadiusTiers.length === 0 && (
                <p className="py-4 text-center text-sm text-surface-400">
                  Nenhuma faixa cadastrada — a entrega ficará indisponível até criar ao menos uma.
                </p>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === "Pagamentos" && (
        <Card className="max-w-2xl space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Pagamento online no cardápio</h3>
              <p className="mt-0.5 text-xs text-surface-500">
                Pix na hora e cartão pelo checkout seguro do Mercado Pago. O valor cai direto na
                sua conta.
              </p>
            </div>
            <Toggle checked={s.mpEnabled} onChange={(v) => saveSettings({ mpEnabled: v })} />
          </div>

          {mpOauthResult === "connected" && (
            <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
              ✓ Conta do Mercado Pago conectada com sucesso!
            </p>
          )}
          {mpOauthResult === "error" && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              Não foi possível concluir a conexão com o Mercado Pago. Tente novamente.
            </p>
          )}

          {mpConnectError && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {mpConnectError}
            </p>
          )}

          {s.mpConfigured ? (
            <div className="flex items-center justify-between gap-3">
              <Badge color="green">✓ Conta Mercado Pago conectada</Badge>
              <button
                type="button"
                onClick={disconnectMercadoPago}
                disabled={disconnectingMp}
                className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
              >
                {disconnectingMp ? "Desconectando..." : "Desconectar"}
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-surface-200 p-4 text-center dark:border-surface-700">
              <p className="mb-3 text-sm text-surface-500">
                Conecte sua conta do Mercado Pago com um clique — você é redirecionado, confirma lá, e volta
                pronto pra receber pagamentos. Sem copiar nenhum código.
              </p>
              <Button onClick={connectMercadoPago} disabled={connectingMp}>
                {connectingMp ? "Conectando..." : "Conectar com Mercado Pago"}
              </Button>
            </div>
          )}

          <details className="rounded-xl border border-surface-200 p-3 text-xs dark:border-surface-700">
            <summary className="cursor-pointer select-none font-medium text-surface-500">
              {s.mpConfigured ? "Trocar conexão manualmente (avançado)" : "Prefiro colar o Access Token manualmente"}
            </summary>
            <div className="mt-3 space-y-3">
              <div className="rounded-xl bg-surface-50 p-4 leading-relaxed text-surface-500 dark:bg-surface-850">
                1. Acesse <strong>mercadopago.com.br</strong> e entre na sua conta<br />
                2. Vá em <strong>Seu negócio → Configurações → Credenciais</strong><br />
                3. Copie o <strong>Access Token de produção</strong> e cole abaixo
              </div>
              <Field label={s.mpConfigured ? "Access Token (já configurado — cole para substituir)" : "Access Token"}>
                <Input
                  type="password"
                  placeholder={s.mpConfigured ? "••••••••••••••••" : "APP_USR-..."}
                  onBlur={(e) => {
                    if (e.target.value.trim()) {
                      saveSettings({ mpAccessToken: e.target.value.trim() } as never);
                      e.target.value = "";
                    }
                  }}
                />
              </Field>
            </div>
          </details>

          <div>
            <div className="mb-2">
              <h3 className="text-sm font-semibold">Checkout de cartão embutido no cardápio</h3>
              <p className="mt-0.5 text-xs text-surface-500">
                Com a Public Key configurada, o cliente paga com cartão sem sair do cardápio —
                nada de redirecionar para o site do Mercado Pago. É a mesma tela de credenciais,
                mas essa chave <strong>não é secreta</strong> (fica no mesmo lugar do Access Token).
              </p>
            </div>
            <Field label="Public Key">
              <Input
                key={s.mpPublicKey ?? "empty"}
                defaultValue={s.mpPublicKey ?? ""}
                placeholder="APP_USR-..."
                onBlur={(e) => saveSettings({ mpPublicKey: e.target.value.trim() || null })}
              />
            </Field>
            {s.mpPublicKey ? (
              <Badge color="green">✓ Checkout de cartão embutido ativo</Badge>
            ) : (
              <Badge color="amber">Sem Public Key — pagamento com cartão fica indisponível no cardápio</Badge>
            )}
          </div>
        </Card>
      )}

      {tab === "iFood" && (
        <Card className="max-w-2xl space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">iFood Entregas</h3>
              <p className="mt-0.5 text-xs text-surface-500">
                Pede um entregador do iFood pra buscar pedidos feitos pelo SEU cardápio/WhatsApp/balcão —
                não mistura com pedidos do marketplace iFood.
              </p>
            </div>
            <Toggle checked={s.ifoodEnabled} onChange={(v) => saveSettings({ ifoodEnabled: v })} />
          </div>

          <div className="rounded-xl bg-surface-50 p-4 text-xs leading-relaxed text-surface-500 dark:bg-surface-850">
            <p className="mb-1 font-semibold text-surface-700 dark:text-surface-200">
              Sem credenciais configuradas, a integração roda em modo demonstração
            </p>
            As solicitações de entrega ficam registradas no log do servidor, sem chamar a API real do iFood — dá pra
            testar o fluxo sem já ter uma conta aprovada no Portal do Parceiro.
          </div>

          <Field label="Merchant ID">
            <Input
              defaultValue={s.ifoodMerchantId ?? ""}
              placeholder="ID da loja no Portal do Parceiro"
              onBlur={(e) => saveSettings({ ifoodMerchantId: e.target.value.trim() || null })}
            />
          </Field>
          <Field label="Client ID">
            <Input
              defaultValue={s.ifoodClientId ?? ""}
              placeholder="Client ID da aplicação"
              onBlur={(e) => saveSettings({ ifoodClientId: e.target.value.trim() || null })}
            />
          </Field>
          <Field label={s.ifoodConfigured ? "Client Secret (já configurado — cole para substituir)" : "Client Secret"}>
            <Input
              type="password"
              placeholder={s.ifoodConfigured ? "••••••••••••••••" : "Client Secret da aplicação"}
              onBlur={(e) => {
                if (e.target.value.trim()) {
                  saveSettings({ ifoodClientSecret: e.target.value.trim() } as never);
                  e.target.value = "";
                }
              }}
            />
          </Field>
          {s.ifoodConfigured ? (
            <Badge color="green">✓ Credenciais configuradas — modo real ativo</Badge>
          ) : (
            <Badge color="amber">Sem Client Secret — rodando em modo demonstração</Badge>
          )}
        </Card>
      )}

      {tab === "Fidelidade" && <LoyaltyTab />}

      {tab === "Equipe" && (
        <Card className="max-w-2xl p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Usuários</h3>
            <Button size="sm" onClick={() => setUserModal(true)}>
              <Plus size={14} /> Novo usuário
            </Button>
          </div>
          <div className="divide-y divide-surface-100 dark:divide-surface-800">
            {users.map((u) => {
              const isSelf = u.id === user?.id;
              return (
                <div key={u.id} className="flex items-center gap-3 py-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-sm font-semibold text-brand-600 dark:text-brand-400">
                    {u.name.charAt(0)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {u.name} {isSelf && <span className="text-xs text-surface-400">(você)</span>}
                    </p>
                    <p className="text-xs text-surface-400">{u.email}</p>
                  </div>
                  <Badge color={u.role === "ADMIN" ? "purple" : "gray"}>{ROLE_LABELS[u.role]}</Badge>
                  {isSelf ? (
                    <Badge color={u.active ? "green" : "red"}>{u.active ? "Ativo" : "Inativo"}</Badge>
                  ) : (
                    <>
                      <Toggle
                        checked={u.active}
                        onChange={(v) => toggleUserActive(u, v)}
                        label={u.active ? "Ativo" : "Inativo"}
                      />
                      <button
                        onClick={() => removeUser(u)}
                        className="p-1.5 text-surface-300 transition-colors hover:text-red-500"
                        title="Remover da equipe"
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === "Auditoria" && canViewAudit && <AuditLogTab />}

      {tab === "QR Code" && (
        <Card className="max-w-md p-6 text-center">
          <h3 className="mb-1 flex items-center justify-center gap-2 text-sm font-semibold">
            <QrCode size={16} /> Cardápio Digital
          </h3>
          <p className="mb-4 text-xs text-surface-500">
            Imprima e cole nas mesas ou divulgue nas redes sociais.
          </p>
          <div className="mb-4 text-left">
            <Field label="Endereço do cardápio">
              <p className="mb-1 truncate text-xs text-surface-400">{window.location.origin}/cardapio/</p>
              <Input key={tenant?.slug} defaultValue={tenant?.slug} onBlur={(e) => saveTenantSlug(e.target.value)} />
            </Field>
            {tenantSlugError && (
              <p className="mt-1.5 text-xs text-red-500">{tenantSlugError}</p>
            )}
            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
              Atenção: mudar isso troca o link do cardápio. QR codes e links já impressos ou
              compartilhados param de funcionar.
            </p>
          </div>
          <img
            src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(menuUrl)}`}
            alt="QR Code do cardápio"
            className="mx-auto rounded-2xl border border-surface-200 p-2 dark:border-surface-700 dark:bg-white"
          />
          <p className="mt-4 break-all rounded-xl bg-surface-50 px-3 py-2 font-mono text-xs text-surface-500 dark:bg-surface-850">
            {menuUrl}
          </p>
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => navigator.clipboard.writeText(menuUrl)}
          >
            Copiar link
          </Button>
        </Card>
      )}

      <Modal open={mapModal} onClose={() => setMapModal(false)} title="Marcar localização no mapa" wide>
        <p className="mb-3 text-xs text-surface-500">
          Clique no mapa ou arraste o pino até a localização exata do estabelecimento.
        </p>
        <LocationPickerMap
          lat={draftPoint.lat}
          lng={draftPoint.lng}
          onChange={(lat, lng) => setDraftPoint({ lat, lng })}
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={useBrowserLocationForMap}
            disabled={locatingBrowser}
            className="flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            <Crosshair size={13} />
            {locatingBrowser ? "Localizando..." : "Usar minha localização atual"}
          </button>
          <span className="font-mono text-xs text-surface-400">
            {draftPoint.lat.toFixed(5)}, {draftPoint.lng.toFixed(5)}
          </span>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setMapModal(false)}>
            Cancelar
          </Button>
          <Button type="button" onClick={confirmMapLocation}>
            Salvar localização
          </Button>
        </div>
      </Modal>

      <Modal open={tierModal} onClose={() => setTierModal(false)} title="Nova faixa de entrega">
        <form
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            await api.post("/settings/delivery-radius", {
              maxKm: parseFloat(tierForm.maxKm.replace(",", ".")),
              feeCents: parseBrl(tierForm.fee),
              etaMinutes: parseInt(tierForm.eta) || 45,
            });
            setTierModal(false);
            setTierForm({ maxKm: "", fee: "", eta: "45" });
            load();
          }}
          className="space-y-4"
        >
          <Field label="Até quantos km *">
            <Input
              value={tierForm.maxKm}
              onChange={(e) => setTierForm({ ...tierForm, maxKm: e.target.value })}
              placeholder="3"
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Taxa (R$) *">
              <Input
                value={tierForm.fee}
                onChange={(e) => setTierForm({ ...tierForm, fee: e.target.value })}
                placeholder="8,00"
                required
              />
            </Field>
            <Field label="Tempo estimado (min)">
              <Input
                type="number"
                value={tierForm.eta}
                onChange={(e) => setTierForm({ ...tierForm, eta: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setTierModal(false)}>
              Cancelar
            </Button>
            <Button type="submit">Adicionar</Button>
          </div>
        </form>
      </Modal>

      <Modal open={userModal} onClose={() => setUserModal(false)} title="Novo usuário">
        <form
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            await api.post("/settings/users", userForm);
            setUserModal(false);
            setUserForm({ name: "", email: "", password: "", role: "ATTENDANT" });
            load();
          }}
          className="space-y-4"
        >
          <Field label="Nome *">
            <Input
              value={userForm.name}
              onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="E-mail *">
              <Input
                type="email"
                value={userForm.email}
                onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                required
              />
            </Field>
            <Field label="Senha *">
              <Input
                type="password"
                value={userForm.password}
                onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                required
                minLength={6}
              />
            </Field>
          </div>
          <Field label="Perfil">
            <Select
              value={userForm.role}
              onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
            >
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setUserModal(false)}>
              Cancelar
            </Button>
            <Button type="submit">Criar usuário</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** Seleção de impressora térmica + início automático — só existe dentro do app desktop (Electron). */
function DesktopPrinterField() {
  const [printers, setPrinters] = useState<{ name: string; displayName: string; isDefault: boolean }[]>([]);
  const [selected, setSelected] = useState("");
  const [autoLaunch, setAutoLaunch] = useState(false);

  useEffect(() => {
    window.electronAPI?.getPrinters().then(setPrinters).catch(() => {});
    window.electronAPI
      ?.getSelectedPrinter()
      .then((name) => setSelected(name ?? ""))
      .catch(() => {});
    window.electronAPI?.getAutoLaunch().then(setAutoLaunch).catch(() => {});
  }, []);

  return (
    <div className="space-y-3 rounded-xl bg-surface-50 p-3 dark:bg-surface-850">
      <Field label="Impressora térmica">
        <Select
          value={selected}
          onChange={(e) => {
            const name = e.target.value;
            setSelected(name);
            window.electronAPI?.setSelectedPrinter(name || null);
          }}
        >
          <option value="">Impressora padrão do sistema</option>
          {printers.map((p) => (
            <option key={p.name} value={p.name}>
              {(p.displayName || p.name) + (p.isDefault ? " (padrão)" : "")}
            </option>
          ))}
        </Select>
      </Field>
      <Toggle
        checked={autoLaunch}
        onChange={(v) => {
          setAutoLaunch(v);
          window.electronAPI?.setAutoLaunch(v);
        }}
        label="Iniciar automaticamente com o Windows"
      />
    </div>
  );
}
