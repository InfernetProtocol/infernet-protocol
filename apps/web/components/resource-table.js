import Link from "next/link";

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  return String(value);
}

export default function ResourceTable({ title, description, columns, rows, emptyMessage }) {
  return (
    <section className="overflow-hidden rounded-[1.5rem] border border-white/10 bg-[var(--panel)]">
      <div className="border-b border-white/10 px-5 py-4">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-white/5 text-[var(--muted)]">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className="px-5 py-3 font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-5 py-8 text-[var(--muted)]" colSpan={columns.length}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={row.id ?? `${title}-${index}`} className="border-t border-white/10">
                  {columns.map((column) => (
                    <td key={column.key} className="px-5 py-4 text-white/90">
                      {column.hrefKey && row[column.hrefKey] ? (
                        <Link href={row[column.hrefKey]} className="text-[var(--accent)] hover:underline">
                          {formatValue(row[column.key])}
                        </Link>
                      ) : (
                        formatValue(row[column.key])
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
