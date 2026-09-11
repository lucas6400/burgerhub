import { Router } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { put } from "@vercel/blob";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";

export const uploadsRoutes = Router();
uploadsRoutes.use(requireAuth);

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_SIZE = 4 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIME.has(file.mimetype));
  },
});

function slugifyFileName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

uploadsRoutes.post(
  "/image",
  requireRole("MANAGER"),
  upload.single("file"),
  h(async (req, res) => {
    if (!req.file) {
      throw new AppError(400, "Envie uma imagem (JPEG, PNG, WEBP ou GIF de até 4MB)");
    }
    const tenantId = tenantOf(req);
    const base = slugifyFileName(req.file.originalname.replace(/\.[^.]+$/, "")) || "imagem";
    const ext = ALLOWED_MIME.has(req.file.mimetype) ? req.file.mimetype.split("/")[1] : "jpg";
    const pathname = `tenants/${tenantId}/products/${randomUUID()}-${base}.${ext}`;

    const blob = await put(pathname, req.file.buffer, {
      access: "public",
      contentType: req.file.mimetype,
    });

    res.status(201).json({ url: blob.url });
  }),
);
