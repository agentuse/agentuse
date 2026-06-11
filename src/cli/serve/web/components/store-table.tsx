import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';

export interface StoreTableColumn<Row> {
  key: string;
  label: string;
  type?: 'text' | 'number';
  defaultDirection?: 'asc' | 'desc';
  sortValue: (row: Row) => string | number;
  render: (row: Row) => ComponentChildren;
}

/**
 * Sortable table with the same semantics as the legacy DOM-sorting script:
 * per-column sort type and default direction, aria-sort on the active header,
 * stable tiebreak by original row order. Sorts data in state instead of
 * moving DOM nodes.
 */
export function StoreTable<Row>(props: {
  columns: Array<StoreTableColumn<Row>>;
  rows: Row[];
  defaultSortKey: string;
  defaultSortDirection?: 'asc' | 'desc';
  rowKey: (row: Row) => string;
  rowProps?: (row: Row) => Record<string, unknown>;
}) {
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' }>({
    key: props.defaultSortKey,
    direction: props.defaultSortDirection ?? 'desc',
  });

  const sorted = useMemo(() => {
    const column = props.columns.find((c) => c.key === sort.key);
    if (!column) return props.rows;
    const type = column.type ?? 'text';
    return props.rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const left = column.sortValue(a.row);
        const right = column.sortValue(b.row);
        const primary = type === 'number'
          ? Number(left) - Number(right)
          : String(left).toLocaleLowerCase().localeCompare(String(right).toLocaleLowerCase(), undefined, { numeric: true, sensitivity: 'base' });
        if (primary !== 0) return sort.direction === 'asc' ? primary : -primary;
        return a.index - b.index;
      })
      .map((wrapped) => wrapped.row);
  }, [props.rows, props.columns, sort]);

  const onHeaderClick = (column: StoreTableColumn<Row>) => {
    setSort((current) => {
      if (current.key === column.key) {
        return { key: column.key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      return {
        key: column.key,
        direction: column.defaultDirection ?? ((column.type ?? 'text') === 'number' ? 'desc' : 'asc'),
      };
    });
  };

  return (
    <table class="store-table">
      <thead>
        <tr>
          {props.columns.map((column) => (
            <th
              key={column.key}
              aria-sort={sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
            >
              <button class="sort-header" type="button" onClick={() => onHeaderClick(column)}>
                {column.label}
                <span class="sort-indicator" aria-hidden="true" />
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={props.rowKey(row)} {...(props.rowProps?.(row) ?? {})}>
            {props.columns.map((column) => (
              <td key={column.key}>{column.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
