"use client";

import React, { useId } from "react";

interface ResponsiveTableProps {
  caption: string;
  columns: string[];
  rows: Array<Record<string, any>>;
}

function formatHeader(col: string): string {
  return col
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace("Xg", "xG")
    .replace("Xgf", "xGF")
    .replace("Xga", "xGA")
    .replace("Xgd", "xGD")
    .replace("Xpts", "xPTS")
    .replace("Pct", "%");
}

export function ResponsiveTable({ caption, columns, rows }: ResponsiveTableProps) {
  const captionId = useId();
  if (!columns.length || !rows.length) {
    return null;
  }

  return (
    <div tabIndex={0} role="region" aria-labelledby={captionId} className="table-wrapper">
      <table className="studio-table">
        <caption id={captionId}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col} scope="col">
                {formatHeader(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={rIdx}>
              {columns.map((col, cIdx) => {
                const rawVal = row[col];
                const display = rawVal === null || rawVal === undefined ? "—" : String(rawVal);
                if (cIdx === 0) {
                  return (
                    <th key={col} scope="row">
                      {display}
                    </th>
                  );
                }
                return (
                  <td key={col} data-label={formatHeader(col)}>
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
