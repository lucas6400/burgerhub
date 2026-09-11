import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";

interface SortableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  onReorder: (newItems: T[]) => void;
  renderItem: (item: T, dragHandle: ReactNode) => ReactNode;
}

/** Lista arrastável genérica (arraste pra reordenar) — usada tanto pras
 * categorias quanto pros produtos dentro de uma categoria no cardápio. */
export function SortableList<T>({ items, getId, onReorder, renderItem }: SortableListProps<T>) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((item) => getId(item) === active.id);
    const newIndex = items.findIndex((item) => getId(item) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(items, oldIndex, newIndex));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={items.map(getId)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {items.map((item) => (
            <SortableRow key={getId(item)} id={getId(item)}>
              {(dragHandle) => renderItem(item, dragHandle)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({ id, children }: { id: string; children: (dragHandle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const dragHandle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      className="cursor-grab touch-none text-surface-300 transition-colors hover:text-surface-500 active:cursor-grabbing dark:text-surface-600 dark:hover:text-surface-400"
      aria-label="Arrastar para reordenar"
    >
      <GripVertical size={16} />
    </button>
  );
  return (
    <div ref={setNodeRef} style={style}>
      {children(dragHandle)}
    </div>
  );
}
