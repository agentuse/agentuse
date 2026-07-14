import { useMediaQuery } from '../hooks/use-media-query';
import { useScrollspy } from '../hooks/use-scrollspy';

export interface RailItem {
  id: string;
  label: string;
  count?: number;
}

/**
 * Fixed vertical tick rail for jumping between page sections (projects on
 * /agents, agent groups on /sessions). Each tick is an anchor link; the
 * currently-visible section's label expands via useScrollspy. Hidden when
 * there isn't enough room beside the centered page column, and when there's
 * only one (or zero) section to jump to.
 */
export function GroupRail(props: { items: RailItem[] }) {
  const roomy = useMediaQuery('(min-width: 1320px)');
  const activeId = useScrollspy(props.items.map((i) => i.id));
  if (!roomy || props.items.length < 2) return null;
  return (
    <nav class="group-rail" aria-label="Jump to group">
      {props.items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          class={item.id === activeId ? 'group-rail-item active' : 'group-rail-item'}
          title={item.count !== undefined ? `${item.label} (${item.count})` : item.label}
        >
          <span class="group-rail-label">{item.label}</span>
          <span class="group-rail-tick" aria-hidden="true"></span>
        </a>
      ))}
    </nav>
  );
}
