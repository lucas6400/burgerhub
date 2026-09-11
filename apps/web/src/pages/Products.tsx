import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowUpDown,
  ChefHat,
  ImageOff,
  Link2,
  ListOrdered,
  Pencil,
  Plus,
  Star,
  Upload,
  UtensilsCrossed,
} from "lucide-react";
import { api } from "../lib/api";
import { brl, parseBrl } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  Toggle,
} from "../components/ui";
import { SortableList } from "../components/SortableList";
import type { Category, Product } from "../types";

interface ProductForm {
  name: string;
  description: string;
  price: string;
  promoPrice: string;
  imageUrl: string;
  categoryId: string;
  prepMinutes: string;
  sku: string;
  internalCode: string;
  showInKds: boolean;
}

const emptyForm: ProductForm = {
  name: "",
  description: "",
  price: "",
  promoPrice: "",
  imageUrl: "",
  categoryId: "",
  prepMinutes: "20",
  sku: "",
  internalCode: "",
  showInKds: true,
};

export function ProductsPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showUrlField, setShowUrlField] = useState(false);
  const [categoryModal, setCategoryModal] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [savingCategory, setSavingCategory] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState("");
  const [reordering, setReordering] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    api.get<Product[]>("/products").then(setProducts).catch(console.error);
    api.get<Category[]>("/categories").then(setCategories).catch(console.error);
  }
  useEffect(load, []);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm, categoryId: categories[0]?.id ?? "" });
    setError("");
    setUploadError("");
    setShowUrlField(false);
    setModalOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description ?? "",
      price: (p.priceCents / 100).toFixed(2).replace(".", ","),
      promoPrice: p.promoPriceCents ? (p.promoPriceCents / 100).toFixed(2).replace(".", ",") : "",
      imageUrl: p.imageUrl ?? "",
      categoryId: p.categoryId,
      prepMinutes: String(p.prepMinutes),
      sku: p.sku ?? "",
      internalCode: p.internalCode ?? "",
      showInKds: p.showInKds,
    });
    setError("");
    setUploadError("");
    setShowUrlField(false);
    setModalOpen(true);
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError("");
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setUploadError("Envie uma imagem JPEG, PNG, WEBP ou GIF");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setUploadError("A imagem deve ter até 4MB");
      return;
    }
    setUploading(true);
    try {
      const { url } = await api.upload<{ url: string }>("/uploads/image", file);
      setForm((f) => ({ ...f, imageUrl: url }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Erro ao enviar imagem");
    } finally {
      setUploading(false);
    }
  }

  function openCategoryModal() {
    setCategoryName("");
    setCategoryError("");
    setEditingCategoryId(null);
    setCategoryModal(true);
  }

  async function handleCreateCategory(e: FormEvent) {
    e.preventDefault();
    setSavingCategory(true);
    setCategoryError("");
    try {
      const created = await api.post<Category>("/categories", { name: categoryName });
      setCategories((prev) => [...prev, created]);
      setForm((f) => ({ ...f, categoryId: created.id }));
      setCategoryName("");
      setCategoryModal(false);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Erro ao criar categoria");
    } finally {
      setSavingCategory(false);
    }
  }

  function startEditCategory(c: Category) {
    setEditingCategoryId(c.id);
    // Categorias antigas guardavam ícone separado do nome — junta os dois num
    // campo só, pra ficar no mesmo formato "🥤 Bebidas" que se escreve daqui pra frente.
    setEditCategoryName(c.icon ? `${c.icon} ${c.name}` : c.name);
    setCategoryError("");
  }

  async function saveEditCategory() {
    if (!editingCategoryId) return;
    setSavingCategory(true);
    setCategoryError("");
    try {
      const updated = await api.put<Category>(`/categories/${editingCategoryId}`, {
        name: editCategoryName,
        icon: null,
      });
      setCategories((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      setEditingCategoryId(null);
    } catch (err) {
      setCategoryError(err instanceof Error ? err.message : "Erro ao salvar categoria");
    } finally {
      setSavingCategory(false);
    }
  }

  async function toggleCategoryActive(c: Category, active: boolean) {
    setCategories((prev) => prev.map((x) => (x.id === c.id ? { ...x, active } : x)));
    try {
      await api.put(`/categories/${c.id}`, { active });
    } catch {
      setCategories((prev) => prev.map((x) => (x.id === c.id ? { ...x, active: !active } : x)));
    }
  }

  async function reorderCategories(newOrder: Category[]) {
    const previous = categories;
    setCategories(newOrder);
    try {
      await api.put("/categories/reorder", { ids: newOrder.map((c) => c.id) });
    } catch {
      setCategories(previous);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const payload = {
      name: form.name,
      description: form.description || null,
      priceCents: parseBrl(form.price),
      promoPriceCents: form.promoPrice ? parseBrl(form.promoPrice) : null,
      imageUrl: form.imageUrl || null,
      categoryId: form.categoryId,
      prepMinutes: parseInt(form.prepMinutes) || 20,
      sku: form.sku || null,
      internalCode: form.internalCode || null,
      showInKds: form.showInKds,
    };
    try {
      if (editing) await api.put(`/products/${editing.id}`, payload);
      else await api.post("/products", payload);
      setModalOpen(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  async function toggleAvailability(p: Product, available: boolean) {
    setProducts((prev) => prev?.map((x) => (x.id === p.id ? { ...x, available } : x)) ?? null);
    try {
      await api.patch(`/products/${p.id}/availability`, { available });
    } catch {
      load();
    }
  }

  async function toggleKds(p: Product, showInKds: boolean) {
    setProducts((prev) => prev?.map((x) => (x.id === p.id ? { ...x, showInKds } : x)) ?? null);
    try {
      await api.put(`/products/${p.id}`, { showInKds });
    } catch {
      load();
    }
  }

  async function toggleFeatured(p: Product, featured: boolean) {
    setProducts((prev) => prev?.map((x) => (x.id === p.id ? { ...x, featured } : x)) ?? null);
    try {
      await api.put(`/products/${p.id}`, { featured });
    } catch {
      load();
    }
  }

  async function toggleFavorite(p: Product, favorite: boolean) {
    setProducts(
      (prev) => prev?.map((x) => ({ ...x, favorite: x.id === p.id ? favorite : favorite ? false : x.favorite })) ?? null,
    );
    try {
      await api.patch(`/products/${p.id}/favorite`, { favorite });
    } catch {
      load();
    }
  }

  async function reorderProducts(newOrder: Product[]) {
    if (!categoryFilter || !products) return;
    const previous = products;
    const reorderedIds = new Set(newOrder.map((p) => p.id));
    setProducts([...products.filter((p) => !reorderedIds.has(p.id)), ...newOrder]);
    try {
      await api.put("/products/reorder", { categoryId: categoryFilter, ids: newOrder.map((p) => p.id) });
    } catch {
      setProducts(previous);
    }
  }

  const filtered = products?.filter((p) => !categoryFilter || p.categoryId === categoryFilter);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Produtos"
        subtitle={`${products?.length ?? 0} produtos no cardápio`}
        actions={
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={openCategoryModal}>
              <ListOrdered size={16} /> Categorias
            </Button>
            <Button onClick={openCreate}>
              <Plus size={16} /> Novo produto
            </Button>
          </div>
        }
      />

      <div className="mb-2 flex items-center gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => {
            setCategoryFilter("");
            setReordering(false);
          }}
          className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            !categoryFilter
              ? "bg-brand-500 text-white"
              : "bg-surface-100 text-surface-500 hover:bg-surface-200 dark:bg-surface-800"
          }`}
        >
          Todas
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setCategoryFilter(c.id);
              setReordering(false);
            }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              categoryFilter === c.id
                ? "bg-brand-500 text-white"
                : "bg-surface-100 text-surface-500 hover:bg-surface-200 dark:bg-surface-800"
            }`}
          >
            {c.icon} {c.name}
          </button>
        ))}
      </div>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-surface-400">
          {categoryFilter
            ? "Arraste as categorias em Categorias, e os itens aqui, para mudar a ordem no cardápio."
            : "Selecione uma categoria pra poder reordenar os itens dela."}
        </p>
        {categoryFilter && (
          <Button
            type="button"
            size="sm"
            variant={reordering ? "primary" : "secondary"}
            onClick={() => setReordering((v) => !v)}
          >
            <ArrowUpDown size={14} /> {reordering ? "Concluir" : "Reordenar itens"}
          </Button>
        )}
      </div>

      {reordering && categoryFilter && filtered ? (
        <SortableList
          items={filtered}
          getId={(p) => p.id}
          onReorder={reorderProducts}
          renderItem={(p, dragHandle) => (
            <div className="flex items-center gap-3 rounded-xl border border-surface-200 bg-white px-3 py-2.5 dark:border-surface-700 dark:bg-surface-900">
              {dragHandle}
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-surface-100 dark:bg-surface-800">
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-surface-300">
                    <ImageOff size={16} />
                  </div>
                )}
              </div>
              <span className="flex-1 truncate text-sm font-medium">{p.name}</span>
              <span className="text-sm text-surface-500">{brl(p.promoPriceCents ?? p.priceCents)}</span>
            </div>
          )}
        />
      ) : !filtered ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState
            icon={<UtensilsCrossed size={24} />}
            title="Nenhum produto"
            description="Cadastre seu primeiro produto para montar o cardápio."
            action={
              <Button onClick={openCreate}>
                <Plus size={16} /> Novo produto
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((p) => (
            <Card key={p.id} className="group overflow-hidden transition-shadow hover:shadow-md">
              <button className="w-full text-left" onClick={() => openEdit(p)}>
                <div className="relative h-36 w-full overflow-hidden bg-surface-100 dark:bg-surface-800">
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt={p.name}
                      loading="lazy"
                      className={`h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 ${!p.available ? "opacity-40 grayscale" : ""}`}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-surface-300">
                      <ImageOff size={28} />
                    </div>
                  )}
                  <div className="absolute left-2 top-2 flex flex-col gap-1">
                    {p.promoPriceCents && (
                      <span className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
                        PROMO
                      </span>
                    )}
                    {p.favorite && (
                      <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
                        ⭐ FAVORITO
                      </span>
                    )}
                    {p.featured && !p.favorite && (
                      <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-bold text-white shadow-sm">
                        DESTAQUE
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <h3 className="line-clamp-1 text-sm font-semibold">{p.name}</h3>
                    <Badge>{p.category?.name}</Badge>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-xs text-surface-500">{p.description}</p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-base font-bold text-brand-600 dark:text-brand-400">
                      {brl(p.promoPriceCents ?? p.priceCents)}
                    </span>
                    {p.promoPriceCents && (
                      <span className="text-xs text-surface-400 line-through">{brl(p.priceCents)}</span>
                    )}
                  </div>
                </div>
              </button>
              <div className="flex items-center justify-between border-t border-surface-100 px-3.5 py-2.5 dark:border-surface-800">
                <span className="flex items-center gap-2 text-xs text-surface-400">
                  {p.internalCode && (
                    <span className="rounded-md bg-surface-900 px-1.5 py-0.5 font-mono font-bold text-white dark:bg-surface-100 dark:text-surface-900">
                      {p.internalCode}
                    </span>
                  )}
                  {p.prepMinutes} min
                </span>
                <Toggle
                  checked={p.available}
                  onChange={(v) => toggleAvailability(p, v)}
                  label={p.available ? "Disponível" : "Esgotado"}
                />
              </div>
              <div className="flex items-center justify-between border-t border-surface-100 px-3.5 py-2 dark:border-surface-800">
                <span className="flex items-center gap-1.5 text-xs text-surface-400">
                  <ChefHat size={12} /> Aparece na Cozinha (KDS)
                </span>
                <Toggle checked={p.showInKds} onChange={(v) => toggleKds(p, v)} />
              </div>
              <div className="flex items-center justify-between border-t border-surface-100 px-3.5 py-2 dark:border-surface-800">
                <span className="flex items-center gap-1.5 text-xs text-surface-400">
                  <Star size={12} /> Destaque no cardápio
                </span>
                <Toggle checked={!!p.featured} onChange={(v) => toggleFeatured(p, v)} />
              </div>
              {p.featured && (
                <div className="flex items-center justify-between border-t border-surface-100 px-3.5 py-2 dark:border-surface-800">
                  <span className="flex items-center gap-1.5 text-xs text-surface-400">
                    <Star size={12} /> Favorito da casa
                  </span>
                  <Toggle checked={!!p.favorite} onChange={(v) => toggleFavorite(p, v)} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Editar — ${editing.name}` : "Novo produto"}
        wide
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome *">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
            <Field label="Categoria *">
              <div className="flex gap-2">
                <Select
                  value={form.categoryId}
                  onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
                  required
                  className="flex-1"
                >
                  {categories.length === 0 && <option value="">Nenhuma categoria ainda</option>}
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon ? `${c.icon} ` : ""}
                      {c.name}
                      {!c.active ? " (desativada)" : ""}
                    </option>
                  ))}
                </Select>
                <Button type="button" variant="secondary" onClick={openCategoryModal} title="Gerenciar categorias">
                  <Pencil size={14} />
                </Button>
              </div>
            </Field>
          </div>
          <Field label="Descrição">
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Preço (R$) *">
              <Input
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                placeholder="24,90"
                required
              />
            </Field>
            <Field label="Preço promo (R$)">
              <Input
                value={form.promoPrice}
                onChange={(e) => setForm({ ...form, promoPrice: e.target.value })}
                placeholder="19,90"
              />
            </Field>
            <Field label="Preparo (min)">
              <Input
                type="number"
                value={form.prepMinutes}
                onChange={(e) => setForm({ ...form, prepMinutes: e.target.value })}
              />
            </Field>
            <Field label="Código PDV">
              <Input
                value={form.internalCode}
                onChange={(e) => setForm({ ...form, internalCode: e.target.value })}
                placeholder="automático"
              />
            </Field>
            <Field label="SKU">
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </Field>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-surface-50 px-3.5 py-2.5 dark:bg-surface-850">
            <span className="flex items-center gap-1.5 text-sm">
              <ChefHat size={14} /> Aparece na Cozinha (KDS)
            </span>
            <Toggle
              checked={form.showInKds}
              onChange={(v) => setForm({ ...form, showInKds: v })}
            />
          </div>
          <Field label="Imagem">
            <div className="flex items-center gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-100 text-surface-300 dark:bg-surface-800">
                {form.imageUrl ? (
                  <img src={form.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <ImageOff size={22} />
                )}
              </div>
              <div className="flex-1 space-y-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={14} /> {uploading ? "Enviando..." : "Enviar imagem"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowUrlField((v) => !v)}
                  >
                    <Link2 size={14} /> Colar link
                  </Button>
                </div>
                {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}
              </div>
            </div>
            {showUrlField && (
              <Input
                className="mt-2"
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                placeholder="https://..."
              />
            )}
          </Field>
          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Salvando..." : editing ? "Salvar alterações" : "Criar produto"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={categoryModal} onClose={() => setCategoryModal(false)} title="Categorias">
        <div className="space-y-4">
          {categories.length === 0 ? (
            <p className="text-sm text-surface-400">Nenhuma categoria ainda.</p>
          ) : (
            <SortableList
              items={categories}
              getId={(c) => c.id}
              onReorder={reorderCategories}
              renderItem={(c, dragHandle) =>
                editingCategoryId === c.id ? (
                  <div className="flex items-center gap-2 rounded-xl border border-brand-500 bg-brand-500/5 px-3 py-2">
                    <Input
                      className="flex-1"
                      value={editCategoryName}
                      onChange={(e) => setEditCategoryName(e.target.value)}
                      placeholder="🥤 Bebidas"
                      autoFocus
                    />
                    <Button type="button" size="sm" onClick={saveEditCategory} disabled={savingCategory}>
                      Salvar
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingCategoryId(null)}>
                      Cancelar
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-surface-200 px-3 py-2 dark:border-surface-700">
                    {dragHandle}
                    <span className={`flex-1 text-sm font-medium ${!c.active ? "text-surface-400" : ""}`}>
                      {c.icon ? `${c.icon} ` : ""}
                      {c.name}
                      {!c.active && <span className="ml-1.5 text-xs">(desativada)</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEditCategory(c)}
                      className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-700 dark:hover:bg-surface-800 dark:hover:text-surface-200"
                      title="Editar nome/ícone"
                    >
                      <Pencil size={14} />
                    </button>
                    <Toggle checked={c.active} onChange={(v) => toggleCategoryActive(c, v)} />
                  </div>
                )
              }
            />
          )}

          <form
            onSubmit={handleCreateCategory}
            className="space-y-3 border-t border-surface-100 pt-4 dark:border-surface-800"
          >
            <p className="text-sm font-semibold">Nova categoria</p>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                placeholder="🥤 Bebidas"
                required
              />
              <Button type="submit" disabled={savingCategory}>
                {savingCategory ? "Criando..." : "Criar"}
              </Button>
            </div>
            {categoryError && (
              <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {categoryError}
              </p>
            )}
          </form>
        </div>
      </Modal>
    </div>
  );
}
