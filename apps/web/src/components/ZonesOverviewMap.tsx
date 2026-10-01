import { useMemo } from "react";
import { ZonePolygonMap, ZONE_COLORS, type OtherZone, type ZonePoint } from "./ZonePolygonMap";

interface Props {
  storeLat: number;
  storeLng: number;
  zones: { id: string; name: string; feeCents: number; polygon: ZonePoint[] }[];
}

/** Todas as zonas de entrega sobrepostas e coloridas; clicar no mapa mostra em qual zona o ponto cai (ou que ficou buraco). */
export function ZonesOverviewMap({ storeLat, storeLng, zones }: Props) {
  const list: OtherZone[] = useMemo(() => zones.map((z) => ({ id: z.id, name: z.name, feeCents: z.feeCents, polygon: z.polygon })), [zones]);
  return (
    <div>
      <ZonePolygonMap storeLat={storeLat} storeLng={storeLng} points={[]} otherZones={list} readOnly className="h-96 w-full rounded-xl" />
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {list.map((z, i) => (
          <span key={z.id} className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: ZONE_COLORS[i % ZONE_COLORS.length] }} />
            {z.name}
          </span>
        ))}
      </div>
      <p className="mt-1 text-xs text-surface-400">
        Clique em qualquer ponto do mapa pra ver em qual zona ele cai. Onde duas zonas se sobrepõem, vale a de menor área. Ponto sem
        zona = buraco (o cliente ali é recusado).
      </p>
    </div>
  );
}
