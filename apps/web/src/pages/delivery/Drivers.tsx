import { useEffect, useState, type FormEvent } from "react";
import { Bike, KeyRound, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { formatPhoneBR } from "../../lib/format";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Skeleton, Toggle } from "../../components/ui";
import { DRIVER_STATUS_LABELS, VEHICLE_TYPE_LABELS, type DriverRow } from "./types";

const EMPTY_FORM = {
  name: "",
  phone: "",
  document: "",
  vehicleType: "MOTORCYCLE",
  vehiclePlate: "",
  maxSimultaneousOrders: "3",
  email: "",
  password: "",
};

export function DriversPage() {
  const [drivers, setDrivers] = useState<DriverRow[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [accessTarget, setAccessTarget] = useState<DriverRow | null>(null);

  function load() {
    api.get<DriverRow[]>("/drivers").then(setDrivers).catch(console.error);
  }
  useEffect(load, []);

  async function toggleActive(d: DriverRow, active: boolean) {
    setDrivers((prev) => prev?.map((x) => (x.id === d.id ? { ...x, active } : x)) ?? null);
    try {
      await api.put(`/drivers/${d.id}`, { active });
    } catch {
      load();
    }
  }

  async function remove(d: DriverRow) {
    if (!confirm(`Remover ${d.name} da equipe de entrega?`)) return;
    try {
      await api.delete(`/drivers/${d.id}`);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao remover entregador");
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/drivers", {
        name: form.name,
        phone: form.phone,
        document: form.document || null,
        vehicleType: form.vehicleType,
        vehiclePlate: form.vehiclePlate || null,
        maxSimultaneousOrders: parseInt(form.maxSimultaneousOrders) || 3,
        email: form.email || undefined,
        password: form.password || undefined,
      });
      setModalOpen(false);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao cadastrar entregador");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Entregadores"
        subtitle={`${drivers?.length ?? 0} cadastrados`}
        actions={
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} /> Novo entregador
          </Button>
        }
      />

      {!drivers ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : drivers.length === 0 ? (
        <Card>
          <EmptyState icon={<Bike size={24} />} title="Nenhum entregador" description="Cadastre sua equipe de entrega pra começar a despachar pedidos." />
        </Card>
      ) : (
        <Card className="divide-y divide-surface-100 overflow-hidden dark:divide-surface-800">
          {drivers.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-600 dark:text-brand-400">
                <Bike size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{d.name}</p>
                <p className="text-xs text-surface-400">
                  {formatPhoneBR(d.phone)} · {VEHICLE_TYPE_LABELS[d.vehicleType]}
                  {d.vehiclePlate && ` · ${d.vehiclePlate}`}
                </p>
              </div>
              <Badge color={d.status === "OFFLINE" ? "gray" : d.status === "AVAILABLE" ? "green" : "blue"}>
                {DRIVER_STATUS_LABELS[d.status]}
              </Badge>
              <span className="hidden text-xs text-surface-400 sm:block">
                até {d.maxSimultaneousOrders} pedidos simultâneos
              </span>
              {d.hasAccess ? (
                <Badge color="blue">App liberado</Badge>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setAccessTarget(d)}>
                  <KeyRound size={13} /> Criar acesso
                </Button>
              )}
              <Toggle checked={d.active} onChange={(v) => toggleActive(d, v)} label={d.active ? "Ativo" : "Inativo"} />
              <button onClick={() => remove(d)} className="p-1 text-surface-300 hover:text-red-500">
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </Card>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Novo entregador">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Nome *">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label="Telefone *">
            <Input
              value={formatPhoneBR(form.phone)}
              onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 11) })}
              placeholder="(11) 91234-5678"
              required
            />
          </Field>
          <Field label="Documento (CPF)">
            <Input value={form.document} onChange={(e) => setForm({ ...form, document: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Veículo">
              <Select value={form.vehicleType} onChange={(e) => setForm({ ...form, vehicleType: e.target.value })}>
                {Object.entries(VEHICLE_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Placa">
              <Input value={form.vehiclePlate} onChange={(e) => setForm({ ...form, vehiclePlate: e.target.value })} />
            </Field>
          </div>
          <Field label="Máximo de pedidos simultâneos">
            <Input
              type="number"
              min={1}
              max={10}
              value={form.maxSimultaneousOrders}
              onChange={(e) => setForm({ ...form, maxSimultaneousOrders: e.target.value })}
            />
          </Field>

          <div className="rounded-xl bg-surface-50 p-3 dark:bg-surface-850">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
              Acesso ao app do entregador (opcional)
            </p>
            <div className="space-y-3">
              <Field label="E-mail de login">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="entregador@email.com"
                />
              </Field>
              <Field label="Senha">
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="mínimo 6 caracteres"
                  minLength={6}
                />
              </Field>
            </div>
            <p className="mt-2 text-xs text-surface-400">
              Preenchendo os dois, o entregador já pode entrar em /motoboy pra aceitar e acompanhar as próprias
              entregas. Pode deixar em branco e criar depois.
            </p>
          </div>

          {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "Salvando..." : "Cadastrar entregador"}
          </Button>
        </form>
      </Modal>

      <CreateAccessModal driver={accessTarget} onClose={() => setAccessTarget(null)} onCreated={load} />
    </div>
  );
}

function CreateAccessModal({
  driver,
  onClose,
  onCreated,
}: {
  driver: DriverRow | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!driver) return;
    setSaving(true);
    setError("");
    try {
      await api.post(`/drivers/${driver.id}/create-access`, { email, password });
      setEmail("");
      setPassword("");
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar acesso");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={!!driver} onClose={onClose} title={driver ? `Criar acesso — ${driver.name}` : ""}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-surface-500">
          Com esse login, {driver?.name} entra em <strong>/motoboy</strong> pra aceitar e acompanhar as próprias
          entregas pelo celular.
        </p>
        <Field label="E-mail de login">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </Field>
        <Field label="Senha">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required />
        </Field>
        {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button type="submit" className="w-full" disabled={saving}>
          {saving ? "Criando..." : "Criar acesso"}
        </Button>
      </form>
    </Modal>
  );
}
