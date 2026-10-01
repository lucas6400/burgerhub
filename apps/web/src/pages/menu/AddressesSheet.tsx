import { useState, type FormEvent } from "react";
import { Crosshair, MapPinned, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { Button, EmptyState, Field, Input, Modal } from "../../components/ui";
import { LocationPickerMap } from "../../components/LocationPickerMap";
import { api, ApiError } from "../../lib/api";
import { useCustomerAuth, type CustomerAddress } from "../../stores/customerAuth";
import { Sheet } from "./PublicMenu";

const DEFAULT_POINT = { lat: -10.1689, lng: -48.3317 }; // Palmas-TO — só ponto de partida antes do GPS/mapa

const emptyForm = {
  label: "Casa",
  street: "",
  number: "",
  neighborhood: "",
  city: "",
  complement: "",
};

/** Endereços salvos do cliente — confirmar o pino uma vez aqui evita o aviso de "localização aproximada" nos próximos pedidos. */
export function AddressesSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { customer, refresh } = useCustomerAuth();
  const [editing, setEditing] = useState<CustomerAddress | "new" | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const addresses = customer?.addresses ?? [];

  function openNew() {
    setForm(emptyForm);
    setPoint(null);
    setError("");
    setEditing("new");
  }

  function openEdit(a: CustomerAddress) {
    setForm({
      label: a.label,
      street: a.street,
      number: a.number,
      neighborhood: a.neighborhood,
      city: a.city,
      complement: a.complement ?? "",
    });
    setPoint(a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null);
    setError("");
    setEditing(a);
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
        setMapOpen(true);
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = { ...form, lat: point?.lat, lng: point?.lng };
      if (editing === "new") await api.post(`/public/${slug}/account/addresses`, body);
      else if (editing) await api.put(`/public/${slug}/account/addresses/${editing.id}`, body);
      refresh();
      setEditing(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao salvar endereço");
    } finally {
      setSaving(false);
    }
  }

  async function remove(a: CustomerAddress) {
    if (!confirm(`Excluir o endereço "${a.label}"?`)) return;
    await api.delete(`/public/${slug}/account/addresses/${a.id}`);
    refresh();
  }

  if (editing) {
    return (
      <Sheet title={editing === "new" ? "Novo endereço" : "Editar endereço"} onClose={() => setEditing(null)}>
        <form onSubmit={save} className="space-y-3">
          <Field label="Nome do endereço (ex.: Casa, Trabalho)">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Rua">
                <Input value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} required />
              </Field>
            </div>
            <Field label="Número">
              <Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} required />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bairro">
              <Input value={form.neighborhood} onChange={(e) => setForm({ ...form, neighborhood: e.target.value })} required />
            </Field>
            <Field label="Cidade">
              <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} required />
            </Field>
          </div>
          <Field label="Complemento (opcional)">
            <Input value={form.complement} onChange={(e) => setForm({ ...form, complement: e.target.value })} />
          </Field>

          <div className="rounded-xl border border-dashed border-surface-200 p-3 dark:border-surface-700">
            {point ? (
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <MapPinned size={13} /> Localização exata confirmada
              </p>
            ) : (
              <p className="mb-2 text-xs text-surface-400">
                Confirme a localização exata no mapa — assim seus próximos pedidos não precisam de confirmação com o
                motoboy.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={useMyLocation}
                disabled={locating}
                className="flex-1"
              >
                <Crosshair size={14} /> {locating ? "Localizando..." : "Usar minha localização"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  if (!point) setPoint(DEFAULT_POINT);
                  setMapOpen(true);
                }}
              >
                Ajustar no mapa
              </Button>
            </div>
          </div>

          {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "Salvando..." : "Salvar endereço"}
          </Button>
        </form>

        <Modal open={mapOpen} onClose={() => setMapOpen(false)} title="Ajustar localização no mapa" wide>
          <div className="space-y-3">
            <p className="text-sm text-surface-500">Arraste o pino até o ponto exato da entrega.</p>
            <LocationPickerMap
              lat={point?.lat ?? DEFAULT_POINT.lat}
              lng={point?.lng ?? DEFAULT_POINT.lng}
              onChange={(lat, lng) => setPoint({ lat, lng })}
              className="h-72 w-full rounded-xl"
            />
            <Button type="button" className="w-full" onClick={() => setMapOpen(false)}>
              Confirmar localização
            </Button>
          </div>
        </Modal>
      </Sheet>
    );
  }

  return (
    <Sheet title="Meus endereços" onClose={onClose}>
      {addresses.length === 0 ? (
        <EmptyState icon={<MapPinned size={22} />} title="Nenhum endereço salvo" description="Salve um endereço pra não digitar de novo nos próximos pedidos." />
      ) : (
        <div className="mb-3 space-y-2">
          {addresses.map((a) => (
            <div key={a.id} className="rounded-xl border border-surface-200 p-3 dark:border-surface-700">
              <div className="mb-1 flex items-center justify-between">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  {a.isDefault && <Star size={12} className="fill-brand-500 text-brand-500" />}
                  {a.label}
                </p>
                <div className="flex gap-1">
                  <button onClick={() => openEdit(a)} className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800">
                    <Pencil size={14} />
                  </button>
                  <button onClick={() => remove(a)} className="rounded-lg p-1.5 text-surface-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <p className="text-xs text-surface-500">
                {a.street}, {a.number} — {a.neighborhood}, {a.city}
              </p>
              {a.lat == null && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  Sem localização exata confirmada — edite pra confirmar no mapa.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="secondary" className="w-full" onClick={openNew}>
        <Plus size={15} /> Novo endereço
      </Button>
    </Sheet>
  );
}
