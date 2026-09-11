import { useRef, useState, type ChangeEvent } from "react";
import { ImageOff, Link2, Trash2, Upload } from "lucide-react";
import { api } from "../lib/api";
import { Button, Field, Input } from "./ui";

interface ImageUploadFieldProps {
  label: string;
  value: string;
  onChange: (url: string) => void;
}

/** Campo de imagem com upload direto pro servidor, ou colar um link — usado
 * em qualquer lugar que hoje só aceitava URL (logo/banner do estabelecimento). */
export function ImageUploadField({ label, value, onChange }: ImageUploadFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showUrlField, setShowUrlField] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      onChange(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Erro ao enviar imagem");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Field label={label}>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface-100 text-surface-300 dark:bg-surface-800">
          {value ? (
            <img src={value} alt="" className="h-full w-full object-cover" />
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
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowUrlField((v) => !v)}>
              <Link2 size={14} /> Colar link
            </Button>
            {value && (
              <Button type="button" variant="danger" size="sm" onClick={() => onChange("")}>
                <Trash2 size={14} /> Remover
              </Button>
            )}
          </div>
          {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}
        </div>
      </div>
      {showUrlField && (
        <Input
          className="mt-2"
          defaultValue={value}
          onBlur={(e) => onChange(e.target.value)}
          placeholder="https://..."
        />
      )}
    </Field>
  );
}
