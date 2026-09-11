import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Star } from "lucide-react";
import { api } from "../../lib/api";
import { brl } from "../../lib/format";

interface ReviewData {
  tenant: { name: string; logoUrl?: string | null };
  order: { number: number; totalCents: number; status: string };
  review: { rating: number; npsScore: number | null; comment: string | null; createdAt: string } | null;
}

export function ReviewPage() {
  const { slug, orderId } = useParams<{ slug: string; orderId: string }>();
  const [data, setData] = useState<ReviewData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rating, setRating] = useState(0);
  const [npsScore, setNpsScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<ReviewData>(`/public/${slug}/orders/${orderId}/review`)
      .then((d) => {
        setData(d);
        if (!d.review) setEditing(true);
      })
      .catch(() => setNotFound(true));
  }, [slug, orderId]);

  function startEditing() {
    setRating(data?.review?.rating ?? 0);
    setNpsScore(data?.review?.npsScore ?? null);
    setComment(data?.review?.comment ?? "");
    setError("");
    setEditing(true);
  }

  async function submit() {
    if (rating < 1) {
      setError("Escolha uma nota de 1 a 5 estrelas.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const review = await api.post<ReviewData["review"]>(`/public/${slug}/orders/${orderId}/review`, {
        rating,
        npsScore: npsScore ?? undefined,
        comment: comment.trim() || undefined,
      });
      setData((prev) => (prev ? { ...prev, review } : prev));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível enviar sua avaliação.");
    } finally {
      setSubmitting(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="text-5xl">🍔</span>
        <h1 className="text-xl font-bold">Pedido não encontrado</h1>
        <p className="text-sm text-surface-500">Confira o link e tente novamente.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <div className="h-24 animate-pulse rounded-2xl bg-surface-200 dark:bg-surface-800" />
        <div className="h-48 animate-pulse rounded-2xl bg-surface-200 dark:bg-surface-800" />
      </div>
    );
  }

  const { tenant, order, review } = data;

  return (
    <div className="flex min-h-screen flex-col items-center bg-surface-50 p-6 dark:bg-surface-950">
      <div className="w-full max-w-md animate-fade-in">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-brand-500 text-2xl shadow-md">
            {tenant.logoUrl ? <img src={tenant.logoUrl} alt="" className="h-full w-full object-cover" /> : "🍔"}
          </span>
          <h1 className="text-lg font-bold">{tenant.name}</h1>
          <p className="text-sm text-surface-500">
            Pedido #{order.number} · {brl(order.totalCents)}
          </p>
        </div>

        {!["DELIVERED", "SETTLED"].includes(order.status) ? (
          <div className="rounded-2xl border border-surface-200 bg-white p-6 text-center dark:border-surface-800 dark:bg-surface-900">
            <p className="text-sm text-surface-500">
              Seu pedido ainda está a caminho. Assim que for entregue, você poderá avaliar por aqui. 🛵
            </p>
          </div>
        ) : editing ? (
          <div className="rounded-2xl border border-surface-200 bg-white p-6 dark:border-surface-800 dark:bg-surface-900">
            <p className="mb-3 text-center text-sm font-medium">O que você achou do seu pedido?</p>
            <div className="mb-5 flex justify-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setRating(n)} className="p-1 transition-transform active:scale-90">
                  <Star
                    size={32}
                    className={n <= rating ? "fill-amber-400 text-amber-400" : "text-surface-300 dark:text-surface-600"}
                  />
                </button>
              ))}
            </div>

            <p className="mb-2 text-center text-xs text-surface-400">
              De 0 a 10, quanto você recomendaria a gente? (opcional)
            </p>
            <div className="mb-5 flex flex-wrap justify-center gap-1.5">
              {Array.from({ length: 11 }, (_, n) => n).map((n) => (
                <button
                  key={n}
                  onClick={() => setNpsScore(npsScore === n ? null : n)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold transition-colors ${
                    npsScore === n
                      ? "bg-brand-500 text-white"
                      : "bg-surface-100 text-surface-500 dark:bg-surface-800"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>

            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 1000))}
              placeholder="Quer contar mais alguma coisa? (opcional)"
              rows={3}
              className="mb-4 w-full rounded-xl border border-surface-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-surface-700 dark:bg-surface-850"
            />

            {error && (
              <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-center text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              onClick={submit}
              disabled={submitting}
              className="w-full rounded-xl bg-brand-500 py-3 font-semibold text-white shadow-lg shadow-brand-500/30 transition-transform active:scale-[0.98] disabled:opacity-60"
            >
              {submitting ? "Enviando..." : "Enviar avaliação"}
            </button>
          </div>
        ) : (
          review && (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-surface-200 bg-white p-6 text-center dark:border-surface-800 dark:bg-surface-900">
              <span className="text-3xl">🙏</span>
              <p className="font-semibold">Obrigado pela sua avaliação!</p>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    size={22}
                    className={n <= review.rating ? "fill-amber-400 text-amber-400" : "text-surface-300 dark:text-surface-600"}
                  />
                ))}
              </div>
              {review.comment && (
                <p className="max-w-xs text-sm text-surface-500">“{review.comment}”</p>
              )}
              <button onClick={startEditing} className="mt-2 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">
                Editar avaliação
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
